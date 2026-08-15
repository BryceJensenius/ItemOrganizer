import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Archive, ArrowLeft, Camera, ImagePlus, LoaderCircle, LocateFixed, LogOut, MapPin, PackageOpen, Pencil, Plus, Search, Sparkles, X } from 'lucide-react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
type Coordinates = { latitude: number; longitude: number }
type ItemDraft = { name: string; locationDescription: string; description: string; keywords: string; coordinates?: Coordinates }
type Item = Omit<ItemDraft, 'keywords'> & { id: string; keywords: string[]; imageUrl?: string; createdAt: string }
const emptyDraft: ItemDraft = { name: '', locationDescription: '', description: '', keywords: '' }

async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || 'Something went wrong. Is the local API running?')
  }
  return response.json()
}

function ProtectedImage({ path, token, alt }: { path: string; token: string; alt: string }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(response => response.ok ? response.blob() : Promise.reject())
      .then(blob => { objectUrl = URL.createObjectURL(blob); setSource(objectUrl) })
      .catch(() => {})
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, token])
  return source ? <img src={source} alt={alt} /> : null
}

function Auth({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [registering, setRegistering] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const data = new FormData(event.currentTarget)
    try {
      const result = await api<{ accessToken: string }>(registering ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) })
      onAuthenticated(result.accessToken)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to sign in') } finally { setBusy(false) }
  }
  return <main className="auth-page"><div className="auth-brand"><Archive size={30} /><span>Stow</span></div><section className="auth-panel"><p className="eyebrow">Your things, findable</p><h1>{registering ? 'Create your account' : 'Welcome back'}</h1><p className="muted">Keep a private record of what you stored and exactly where you put it.</p><form onSubmit={submit}><label>Email<input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label><label>Password<input required minLength={8} name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder="At least 8 characters" /></label>{error && <p className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : registering ? 'Create account' : 'Sign in'}</button></form><button className="text-button" onClick={() => { setRegistering(!registering); setError('') }}>{registering ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></section></main>
}

function ItemForm({ token, item, onSaved, onClose }: { token: string; item?: Item; onSaved: (item: Item) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<ItemDraft>(() => item ? { name: item.name, locationDescription: item.locationDescription, description: item.description, keywords: item.keywords.join(', '), coordinates: item.coordinates } : emptyDraft)
  const [image, setImage] = useState<File>(); const [preview, setPreview] = useState(''); const [busy, setBusy] = useState(false); const [analyzing, setAnalyzing] = useState(false); const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  function chooseImage(file?: File) { if (file) { setImage(file); setPreview(URL.createObjectURL(file)) } }
  function locate() {
    if (!navigator.geolocation) return setError('Location is not supported by this browser.')
    navigator.geolocation.getCurrentPosition(({ coords }) => setDraft(current => ({ ...current, coordinates: { latitude: coords.latitude, longitude: coords.longitude } })), () => setError('Location permission was not granted.'), { enableHighAccuracy: true, timeout: 10000 })
  }
  async function analyze() {
    if (!image) return
    setAnalyzing(true); setError(''); const body = new FormData(); body.append('image', image)
    try { const result = await api<ItemDraft>('/items/analyze', { method: 'POST', body }, token); setDraft(current => ({ ...current, ...result, coordinates: current.coordinates || result.coordinates })) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Image analysis failed') } finally { setAnalyzing(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); const body = new FormData(); body.append('data', JSON.stringify({ ...draft, keywords: draft.keywords.split(',').map(value => value.trim()).filter(Boolean) })); if (image) body.append('image', image)
    try { onSaved(await api<Item>(item ? `/items/${item.id}` : '/items', { method: item ? 'PUT' : 'POST', body }, token)) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save item') } finally { setBusy(false) }
  }
  return <div className="modal-backdrop"><section className="item-form" aria-modal="true" role="dialog"><header><div><p className="eyebrow">{item ? 'Keep it current' : 'Put it away'}</p><h2>{item ? 'Edit item' : 'Add an item'}</h2></div><button className="icon-button" title="Close" onClick={onClose}><X /></button></header><form onSubmit={submit}><div className="capture-area" onClick={() => fileInput.current?.click()}>{preview ? <img src={preview} alt="Item preview" /> : item?.imageUrl ? <ProtectedImage path={item.imageUrl} token={token} alt="Item preview" /> : <><Camera size={34} /><strong>Take a photo</strong><span>or choose from your library</span></>}<input ref={fileInput} hidden type="file" accept="image/*" capture="environment" onChange={event => chooseImage(event.target.files?.[0])} /></div>{image && <button type="button" className="analyze-button" onClick={analyze} disabled={analyzing}><Sparkles size={18} />{analyzing ? 'Identifying item...' : 'Fill details with AI'}</button>}<div className="form-grid"><label>Item name<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Cordless drill" /></label><label>Where is it?<input value={draft.locationDescription} onChange={event => setDraft({ ...draft, locationDescription: event.target.value })} placeholder="Garage, blue cabinet, second shelf" /></label><label className="full">Description<textarea value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="Brand, color, size, or anything memorable" /></label><label className="full">Search words<input value={draft.keywords} onChange={event => setDraft({ ...draft, keywords: event.target.value })} placeholder="tool, screwdriver, repair, battery" /><span className="hint">Separate keywords with commas</span></label></div><button type="button" className={`location-button ${draft.coordinates ? 'located' : ''}`} onClick={locate}><LocateFixed size={18} />{draft.coordinates ? 'Update with my current location' : 'Add my current location'}</button>{error && <p className="form-error">{error}</p>}<footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : item ? 'Save changes' : 'Save item'}</button></footer></form></section></div>
}

function ItemDetail({ item, token, onBack, onEdit }: { item: Item; token: string; onBack: () => void; onEdit: () => void }) {
  const mapUrl = item.coordinates && `https://www.openstreetmap.org/export/embed.html?bbox=${item.coordinates.longitude - .003}%2C${item.coordinates.latitude - .003}%2C${item.coordinates.longitude + .003}%2C${item.coordinates.latitude + .003}&layer=mapnik&marker=${item.coordinates.latitude}%2C${item.coordinates.longitude}`
  return <section className="detail-view"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />Back to items</button><div className="detail-layout"><div className="detail-image">{item.imageUrl ? <ProtectedImage path={item.imageUrl} token={token} alt={item.name || 'Stored item'} /> : <PackageOpen size={54} />}</div><div className="detail-copy"><p className="eyebrow">Stored item</p><div className="detail-title"><h1>{item.name || 'Unnamed item'}</h1><button className="secondary" onClick={onEdit}><Pencil size={16} />Edit</button></div><div className="location-callout"><MapPin /><div><span>Find it here</span><strong>{item.locationDescription || 'No location description added'}</strong></div></div>{item.description && <p>{item.description}</p>}<div className="tags">{item.keywords.map(keyword => <span key={keyword}>{keyword}</span>)}</div></div></div>{mapUrl && <div className="map"><iframe title="Item location" src={mapUrl} /></div>}</section>
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('stow-token') || '')
  const [items, setItems] = useState<Item[]>([]); const [query, setQuery] = useState(''); const [loading, setLoading] = useState(false); const [showForm, setShowForm] = useState(false); const [editing, setEditing] = useState<Item>(); const [selected, setSelected] = useState<Item>(); const [error, setError] = useState('')
  useEffect(() => {
    if (!token) return
    setLoading(true); const timer = window.setTimeout(() => { api<Item[]>(`/items?search=${encodeURIComponent(query)}`, {}, token).then(setItems).catch(caught => setError(caught.message)).finally(() => setLoading(false)) }, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [token, query])
  function authenticate(value: string) { localStorage.setItem('stow-token', value); setToken(value) }
  function logout() { localStorage.removeItem('stow-token'); setToken(''); setItems([]) }
  if (!token) return <Auth onAuthenticated={authenticate} />
  return <div className="app-shell"><header className="topbar"><button className="brand" onClick={() => setSelected(undefined)}><Archive size={26} /><span>Stow</span></button><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={20} /></button></header><main>{selected ? <ItemDetail item={selected} token={token} onBack={() => setSelected(undefined)} onEdit={() => setEditing(selected)} /> : <><section className="toolbar"><div><p className="eyebrow">Everything in its place</p><h1>What are you looking for?</h1></div><button className="primary desktop-add" onClick={() => setShowForm(true)}><Plus />Add item</button></section><div className="search-box"><Search /><input aria-label="Search items" value={query} onChange={event => setQuery(event.target.value)} placeholder="Try “screwdriver” or “winter gloves”" />{query && <button title="Clear search" onClick={() => setQuery('')}><X size={18} /></button>}</div>{error && <p className="notice">{error}</p>}{loading ? <div className="empty"><LoaderCircle className="spin" /><p>Looking through your things...</p></div> : items.length ? <section className="items-grid">{items.map(item => <button className="item-card" key={item.id} onClick={() => setSelected(item)}><div className="item-thumb">{item.imageUrl ? <ProtectedImage path={item.imageUrl} token={token} alt="" /> : <ImagePlus />}</div><div className="item-card-copy"><h2>{item.name || 'Unnamed item'}</h2><p><MapPin size={16} />{item.locationDescription || 'Location not added'}</p><div className="tags">{item.keywords.slice(0, 3).map(keyword => <span key={keyword}>{keyword}</span>)}</div></div></button>)}</section> : <div className="empty"><PackageOpen size={48} /><h2>{query ? 'Nothing matched that search' : 'Your shelves are ready'}</h2><p>{query ? 'Try a related word or a location.' : 'Add your first item the next time you put something away.'}</p><button className="primary" onClick={() => setShowForm(true)}><Plus />Add an item</button></div>}</>}</main>{!selected && <nav className="mobile-nav"><button className="active"><Search /><span>Find</span></button><button onClick={() => setShowForm(true)}><Plus /><span>Add</span></button></nav>}{(showForm || editing) && <ItemForm token={token} item={editing} onClose={() => { setShowForm(false); setEditing(undefined) }} onSaved={saved => { setItems(current => editing ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current]); if (editing) setSelected(saved); setShowForm(false); setEditing(undefined) }} />}</div>
}
export default App