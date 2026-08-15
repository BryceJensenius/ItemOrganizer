import base64
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any

import jwt
from bson import ObjectId
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from openai import OpenAI
from PIL import ExifTags, Image
from pwdlib import PasswordHash
from pydantic import BaseModel, EmailStr, Field
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
JWT_SECRET = os.getenv("JWT_SECRET", "change-this-development-secret")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
if len(JWT_SECRET) < 32 or JWT_SECRET == "change-this-development-secret":
    raise RuntimeError("JWT_SECRET must be a unique random value of at least 32 characters")


def client_address(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip() or get_remote_address(request)

app = FastAPI(title="Stow Item Organizer API", version="1.0.0")
origins = [value.strip() for value in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "OPTIONS"], allow_headers=["Authorization", "Content-Type"])
limiter = Limiter(key_func=client_address, default_limits=["120/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

database = MongoClient(MONGO_URL)[os.getenv("MONGO_DB", "item_organizer")]
users = database.users
items = database.items
password_hash = PasswordHash.recommended()


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class Coordinates(BaseModel):
    latitude: float
    longitude: float


class ItemInput(BaseModel):
    name: str = ""
    locationDescription: str = ""
    description: str = ""
    keywords: list[str] = Field(default_factory=list)
    coordinates: Coordinates | None = None


class AnalysisResult(BaseModel):
    name: str = ""
    locationDescription: str = ""
    description: str = ""
    keywords: str = ""
    coordinates: Coordinates | None = None


def prepare_database() -> None:
    users.create_index([("email", ASCENDING)], unique=True)
    items.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    items.create_index([("name", "text"), ("location_description", "text"), ("description", "text"), ("keywords", "text")])


@app.on_event("startup")
def startup() -> None:
    prepare_database()


def create_token(user_id: ObjectId) -> str:
    expires = datetime.now(timezone.utc) + timedelta(days=30)
    return jwt.encode({"sub": str(user_id), "exp": expires}, JWT_SECRET, algorithm="HS256")


def current_user(authorization: Annotated[str | None, Header()] = None) -> ObjectId:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = jwt.decode(authorization.removeprefix("Bearer "), JWT_SECRET, algorithms=["HS256"])
        user_id = ObjectId(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired session") from None
    if users.find_one({"_id": user_id}) is None:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    return user_id


def item_response(document: dict[str, Any]) -> dict[str, Any]:
    coordinates = document.get("coordinates")
    return {
        "id": str(document["_id"]),
        "name": document.get("name", ""),
        "locationDescription": document.get("location_description", ""),
        "description": document.get("description", ""),
        "keywords": document.get("keywords", []),
        "coordinates": coordinates,
        "imageUrl": f"/items/{document['_id']}/image" if document.get("image_url") else None,
        "createdAt": document["created_at"].isoformat(),
    }


def gps_from_image(path: Path) -> dict[str, float] | None:
    try:
        with Image.open(path) as image:
            gps = image.getexif().get_ifd(ExifTags.IFD.GPSInfo)
        if not gps:
            return None
        def decimal(values: tuple[Any, Any, Any]) -> float:
            return float(values[0]) + float(values[1]) / 60 + float(values[2]) / 3600
        latitude = decimal(gps[2]) * (-1 if gps.get(1) == "S" else 1)
        longitude = decimal(gps[4]) * (-1 if gps.get(3) == "W" else 1)
        return {"latitude": latitude, "longitude": longitude}
    except (OSError, KeyError, TypeError, ValueError, ZeroDivisionError):
        return None


async def save_image(image: UploadFile) -> tuple[str, Path]:
    content_type = image.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported")
    suffix = Path(image.filename or "image.jpg").suffix.lower() or ".jpg"
    if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".heic"}:
        suffix = ".jpg"
    filename = f"{uuid.uuid4().hex}{suffix}"
    path = UPLOAD_DIR / filename
    content = await image.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image must be smaller than 15 MB")
    path.write_bytes(content)
    return f"/uploads/{filename}", path


@app.get("/health")
def health() -> dict[str, str]:
    database.command("ping")
    return {"status": "ok"}


@app.post("/auth/register", status_code=201)
@limiter.limit("5/hour")
def register(request: Request, credentials: Credentials) -> dict[str, str]:
    try:
        result = users.insert_one({"email": credentials.email.lower(), "password_hash": password_hash.hash(credentials.password), "created_at": datetime.now(timezone.utc)})
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="An account with that email already exists") from None
    return {"accessToken": create_token(result.inserted_id)}


@app.post("/auth/login")
@limiter.limit("10/minute")
def login(request: Request, credentials: Credentials) -> dict[str, str]:
    user = users.find_one({"email": credentials.email.lower()})
    if not user or not password_hash.verify(credentials.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    return {"accessToken": create_token(user["_id"])}


@app.get("/items")
def list_items(search: Annotated[str, Query(max_length=200)] = "", user_id: ObjectId = Depends(current_user)) -> list[dict[str, Any]]:
    criteria: dict[str, Any] = {"user_id": user_id}
    if search.strip():
        criteria["$text"] = {"$search": search.strip()}
    return [item_response(document) for document in items.find(criteria).sort("created_at", DESCENDING).limit(100)]


@app.get("/items/{item_id}/image")
def get_item_image(item_id: str, user_id: ObjectId = Depends(current_user)) -> FileResponse:
    if not ObjectId.is_valid(item_id):
        raise HTTPException(status_code=404, detail="Image not found")
    item = items.find_one({"_id": ObjectId(item_id), "user_id": user_id})
    if item is None or not item.get("image_url"):
        raise HTTPException(status_code=404, detail="Image not found")
    path = UPLOAD_DIR / Path(item["image_url"]).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path)


@app.post("/items", status_code=201)
async def create_item(data: Annotated[str, Form()], image: Annotated[UploadFile | None, File()] = None, user_id: ObjectId = Depends(current_user)) -> dict[str, Any]:
    try:
        item = ItemInput.model_validate_json(data)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Item data is invalid") from error
    image_url = None
    image_path = None
    if image:
        image_url, image_path = await save_image(image)
    coordinates = item.coordinates.model_dump() if item.coordinates else (gps_from_image(image_path) if image_path else None)
    document = {"user_id": user_id, "name": item.name.strip(), "location_description": item.locationDescription.strip(), "description": item.description.strip(), "keywords": [word.lower() for word in item.keywords], "coordinates": coordinates, "image_url": image_url, "created_at": datetime.now(timezone.utc)}
    result = items.insert_one(document)
    document["_id"] = result.inserted_id
    return item_response(document)


@app.put("/items/{item_id}")
async def update_item(item_id: str, data: Annotated[str, Form()], image: Annotated[UploadFile | None, File()] = None, user_id: ObjectId = Depends(current_user)) -> dict[str, Any]:
    if not ObjectId.is_valid(item_id):
        raise HTTPException(status_code=404, detail="Item not found")
    existing = items.find_one({"_id": ObjectId(item_id), "user_id": user_id})
    if existing is None:
        raise HTTPException(status_code=404, detail="Item not found")
    try:
        item = ItemInput.model_validate_json(data)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Item data is invalid") from error
    image_url = existing.get("image_url")
    image_path = None
    if image:
        image_url, image_path = await save_image(image)
    coordinates = item.coordinates.model_dump() if item.coordinates else (gps_from_image(image_path) if image_path else None)
    changes = {"name": item.name.strip(), "location_description": item.locationDescription.strip(), "description": item.description.strip(), "keywords": [word.lower() for word in item.keywords], "coordinates": coordinates, "image_url": image_url, "updated_at": datetime.now(timezone.utc)}
    items.update_one({"_id": existing["_id"], "user_id": user_id}, {"$set": changes})
    if image and existing.get("image_url"):
        (UPLOAD_DIR / Path(existing["image_url"]).name).unlink(missing_ok=True)
    existing.update(changes)
    return item_response(existing)


@app.post("/items/analyze")
@limiter.limit("20/hour")
async def analyze_item(request: Request, image: Annotated[UploadFile, File()], _: ObjectId = Depends(current_user)) -> AnalysisResult:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured on the API")
    image_url, image_path = await save_image(image)
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    mime = image.content_type or "image/jpeg"
    client = OpenAI(api_key=OPENAI_API_KEY)
    response = client.beta.chat.completions.parse(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[
            {"role": "system", "content": "Identify the pictured household item. Generate a concise name and description plus broad search synonyms and likely terms a person might use to find it. Do not invent its storage location."},
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}}]},
        ],
        response_format=AnalysisResult,
    )
    result = response.choices[0].message.parsed
    if result is None:
        raise HTTPException(status_code=502, detail="The image could not be analyzed")
    result.coordinates = Coordinates(**gps) if (gps := gps_from_image(image_path)) else None
    result.keywords = ", ".join(result.keywords) if isinstance(result.keywords, list) else result.keywords
    Path(UPLOAD_DIR / Path(image_url).name).unlink(missing_ok=True)
    return result