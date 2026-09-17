import './style.css'

type Point = { x: number; y: number }
type Barcode = { format: string; rawValue?: string; boundingBox?: DOMRect; cornerPoints?: Point[] }
type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<Barcode[]> }
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

declare global { interface Window { BarcodeDetector?: BarcodeDetectorConstructor } }

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main><header><h1>Code 39 BarcodeDetector 検証</h1><p class="muted">ブラウザ標準APIの認識性能を確認する実験用ツール</p></header>
  <section class="status"><span id="cameraStatus">● Camera: stopped</span><span id="apiStatus">● BarcodeDetector: checking</span><span id="supportStatus">● Code 39: checking</span><span id="detectStatus">● Detecting: idle</span></section>
  <section class="toolbar"><button id="start">Start Camera</button><button id="stop" disabled>Stop Camera</button><label class="file">Select Image<input id="image" type="file" accept="image/*"></label><button id="clear">Clear Log</button><button id="download" disabled>Download ZIP (0)</button></section>
  <div id="error" class="error" hidden></div>
  <section class="workspace"><div class="camera-container"><video id="video" autoplay playsinline muted></video><canvas id="overlay"></canvas><div id="found" class="found" hidden></div></div><aside><h2>Statistics</h2><dl><dt>Camera</dt><dd id="resolution">—</dd><dt>Camera FPS</dt><dd id="cameraFps">—</dd><dt>Detection FPS</dt><dd id="detectionFps">—</dd><dt>Detection latency</dt><dd id="latency">—</dd><dt>Last detection</dt><dd id="lastAgo">—</dd><dt>Detections</dt><dd id="count">0</dd><dt>Last result</dt><dd id="lastResult">—</dd></dl><h2>Recognition log</h2><pre id="log">No detections yet.</pre><p class="hint">テスト用Code 39は、対応するバーコード生成サイトで「Code 39」を選び、例: <code>*CUC12345*</code>（多くの生成器では文字列のみ入力）を作成してください。</p></aside></section>
  </main>`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $('video') as HTMLVideoElement, canvas = $('overlay') as HTMLCanvasElement, ctx = canvas.getContext('2d')!
const error = $('error'), detectorStatus = $('apiStatus'), supportStatus = $('supportStatus')
let detector: BarcodeDetectorLike | null = null, stream: MediaStream | null = null, running = false, busy = false
let frameCount = 0, detectionCount = 0, totalDetections = 0, lastFrameTime = performance.now(), lastDetectionAt = 0, lastLogValue = ''
let cameraFps = 0, detectionFps = 0, fpsWindow = performance.now(), windowFrames = 0, windowDetections = 0
const snapshots: { name: string; blob: Blob }[] = []
const frameBuffer: { canvas: HTMLCanvasElement; score: number; at: number }[] = []

const validValuePattern = /^(?:28V\s\w{1,3}|\w{4})$/
function isValidValue(value: string | undefined) { return value !== undefined && validValuePattern.test(value) }
function bufferFrame(at: number) {
  if (!video.videoWidth || !video.videoHeight) return
  const imageCanvas = document.createElement('canvas'); imageCanvas.width = video.videoWidth; imageCanvas.height = video.videoHeight
  const imageContext = imageCanvas.getContext('2d', { willReadFrequently: true })!; imageContext.drawImage(video, 0, 0)
  const pixels = imageContext.getImageData(0, 0, imageCanvas.width, imageCanvas.height).data; let score = 0
  for (let y = 1; y < imageCanvas.height - 1; y += 4) for (let x = 1; x < imageCanvas.width - 1; x += 4) { const i = (y * imageCanvas.width + x) * 4; const center = pixels[i] + pixels[i + 1] + pixels[i + 2]; const left = pixels[i - 4] + pixels[i - 3] + pixels[i - 2]; const right = pixels[i + 4] + pixels[i + 5] + pixels[i + 6]; const up = pixels[i - imageCanvas.width * 4] + pixels[i - imageCanvas.width * 4 + 1] + pixels[i - imageCanvas.width * 4 + 2]; const down = pixels[i + imageCanvas.width * 4] + pixels[i + imageCanvas.width * 4 + 1] + pixels[i + imageCanvas.width * 4 + 2]; score += Math.abs(4 * center - left - right - up - down) }
  frameBuffer.push({ canvas: imageCanvas, score, at }); while (frameBuffer.length && at - frameBuffer[0].at > 500) frameBuffer.shift()
}
function captureFrame(value: string) {
  const best = frameBuffer.reduce((current, frame) => !current || frame.score > current.score ? frame : current, undefined as typeof frameBuffer[number] | undefined)
  if (!best) return Promise.resolve()
  return new Promise<void>(resolve => best.canvas.toBlob(blob => { if (blob) { const safe = value.replace(/[^\w-]/g, '_'); snapshots.push({ name: `${String(snapshots.length + 1).padStart(3, '0')}_${safe}.jpg`, blob }); setText('download', `Download ZIP (${snapshots.length})`); $('download').removeAttribute('disabled') } resolve() }, 'image/jpeg', 0.92))
}
function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
async function downloadZip() { if (!snapshots.length) return; const encoder = new TextEncoder(), parts: BlobPart[] = [], central: Uint8Array[] = []; let offset = 0
  for (const file of snapshots) { const name = encoder.encode(file.name), data = new Uint8Array(await file.blob.arrayBuffer()), crc = crc32(data), header = new ArrayBuffer(30 + name.length), view = new DataView(header); view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint32(14, crc, true); view.setUint16(26, name.length, true); new Uint8Array(header, 30).set(name); parts.push(header, data.buffer as ArrayBuffer)
    const entry = new ArrayBuffer(46 + name.length), ev = new DataView(entry); ev.setUint32(0, 0x02014b50, true); ev.setUint16(4, 20, true); ev.setUint16(6, 20, true); ev.setUint32(16, crc, true); ev.setUint32(20, data.length, true); ev.setUint32(24, data.length, true); ev.setUint16(28, name.length, true); ev.setUint32(42, offset, true); new Uint8Array(entry, 46).set(name); central.push(new Uint8Array(entry)); offset += 30 + name.length + data.length }
  const centralSize = central.reduce((n, x) => n + x.length, 0), end = new ArrayBuffer(22), endView = new DataView(end); endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, snapshots.length, true); endView.setUint16(10, snapshots.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true); const url = URL.createObjectURL(new Blob([...parts, ...central.map(x => x.buffer as ArrayBuffer), end], { type: 'application/zip' })); const link = document.createElement('a'); link.href = url; link.download = 'barcode-snapshots.zip'; link.click(); URL.revokeObjectURL(url) }

function showError(message: string) { error.textContent = message; error.hidden = false }
function setText(id: string, value: string) { $(id).textContent = value }
function resizeCanvas() { canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480; canvas.style.aspectRatio = `${canvas.width}/${canvas.height}`; setText('resolution', `${canvas.width} × ${canvas.height}`) }
function draw(results: Barcode[]) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = Math.max(3, canvas.width / 400); ctx.font = `${Math.max(16, canvas.width / 45)}px sans-serif`; results.forEach((b, i) => { const box = b.boundingBox; const pts = b.cornerPoints; ctx.strokeStyle = '#39ff88'; ctx.fillStyle = '#39ff88'; if (box) ctx.strokeRect(box.x, box.y, box.width, box.height); else if (pts?.length) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.stroke() } const value = b.rawValue || '(no value)'; const x = box?.x ?? pts?.[0]?.x ?? 8, y = box?.y ?? pts?.[0]?.y ?? 24; ctx.fillText(value, x, Math.max(20, y - 8 + i * 20)) }) }
function addLog(value: string) { const now = performance.now(); if (value === lastLogValue && now - lastDetectionAt < 1000) return; lastLogValue = value; const line = `${new Date().toLocaleTimeString('ja-JP', { hour12: false })}.${String(new Date().getMilliseconds()).padStart(3, '0')}  ${value}`; const el = $('log'); el.textContent = (el.textContent === 'No detections yet.' ? '' : el.textContent + '\n') + line; el.scrollTop = el.scrollHeight }
async function detect() { if (!detector || busy || !running) return; busy = true; const started = performance.now(); try { const results = (await detector.detect(video)).filter(b => isValidValue(b.rawValue)); setText('latency', `${(performance.now() - started).toFixed(1)} ms`); detectionCount++; windowDetections++; totalDetections += results.length; setText('count', String(totalDetections)); if (results.length) { const value = results[0].rawValue!; await captureFrame(value); lastDetectionAt = performance.now(); setText('lastResult', `${results[0].format}: ${value}`); $('found').textContent = `FOUND: ${value}`; $('found').hidden = false; addLog(value) } else $('found').hidden = true; draw(results) } catch (e) { showError(`BarcodeDetector.detect() に失敗しました: ${e instanceof Error ? e.message : String(e)}`) } finally { busy = false } }
function frame(now: number) { if (!running) return; frameCount++; windowFrames++; if (now - fpsWindow >= 1000) { cameraFps = windowFrames * 1000 / (now - fpsWindow); detectionFps = windowDetections * 1000 / (now - fpsWindow); setText('cameraFps', cameraFps.toFixed(1)); setText('detectionFps', detectionFps.toFixed(1)); windowFrames = windowDetections = 0; fpsWindow = now } if (now - lastFrameTime >= 75) { lastFrameTime = now; bufferFrame(now); void detect() } if (lastDetectionAt) setText('lastAgo', `${Math.round(now - lastDetectionAt)} ms ago`); requestAnimationFrame(frame) }
async function startCamera() { if (!detector) return; showError(''); error.hidden = true; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); video.srcObject = stream; await video.play(); resizeCanvas(); running = true; $('start').setAttribute('disabled', 'true'); $('stop').removeAttribute('disabled'); setText('cameraStatus', '● Camera: running'); setText('detectStatus', '● Detecting: active'); requestAnimationFrame(frame) } catch (e) { showError(`カメラを開始できませんでした。HTTPSまたはlocalhostで実行し、カメラ権限を確認してください。\n${e instanceof Error ? e.message : String(e)}`) } }
function stopCamera() { running = false; stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; ctx.clearRect(0, 0, canvas.width, canvas.height); $('start').removeAttribute('disabled'); $('stop').setAttribute('disabled', 'true'); setText('cameraStatus', '● Camera: stopped'); setText('detectStatus', '● Detecting: idle') }
async function init() { if (!window.BarcodeDetector) { detectorStatus.textContent = '● BarcodeDetector: unavailable'; showError('このブラウザでは BarcodeDetector API が利用できません。'); return } detectorStatus.textContent = '● BarcodeDetector: available'; try { const supported = await window.BarcodeDetector.getSupportedFormats(); if (!supported.includes('code_39')) { supportStatus.textContent = '● Code 39: unsupported'; showError('このブラウザ/環境では BarcodeDetector の Code 39 に対応していません。'); return } supportStatus.textContent = '● Code 39: supported'; detector = new window.BarcodeDetector({ formats: ['code_39'] }) } catch (e) { showError(`BarcodeDetector の初期化に失敗しました: ${String(e)}`) } }
$('start').addEventListener('click', () => void startCamera()); $('stop').addEventListener('click', stopCamera); $('clear').addEventListener('click', () => { $('log').textContent = 'No detections yet.'; lastLogValue = '' }); $('download').addEventListener('click', () => void downloadZip()); video.addEventListener('loadedmetadata', resizeCanvas); window.addEventListener('resize', resizeCanvas)
$('image').addEventListener('change', async (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (!file || !detector) return; const image = new Image(); image.onload = async () => { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; ctx.clearRect(0, 0, canvas.width, canvas.height); try { const started = performance.now(); const results = (await detector!.detect(image)).filter(r => isValidValue(r.rawValue)); setText('latency', `${(performance.now() - started).toFixed(1)} ms`); draw(results); setText('count', String(results.length)); setText('lastResult', results[0] ? `${results[0].format}: ${results[0].rawValue}` : '—'); results.forEach(r => addLog(r.rawValue!)); } catch (e) { showError(`画像の解析に失敗しました: ${String(e)}`) } }; image.src = URL.createObjectURL(file) })
void init()
