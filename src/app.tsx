type ProcessingMode = 'basic' | 'person' | 'product';
type ProcessingOptions = { mode: ProcessingMode; smoothEdges: boolean; autoTrim: boolean; keepOriginalSize: boolean; strength: number };
type ProcessingStage = 'idle' | 'uploading' | 'analyzing' | 'removing' | 'generating' | 'done';
type AppErrorType = 'file-size' | 'file-type' | 'ai-failed' | 'network';
type AppError = { type: AppErrorType; message: string };
type BackgroundMode = 'transparent' | 'white' | 'black';
type DownloadFormat = 'png' | 'webp' | 'jpg';
type EditTool = 'strength' | 'eraser' | 'restore' | 'crop' | 'padding' | 'filename';
type ResultRecord = { id: string; batchId: string; originalUrl: string; resultUrl: string; fileName: string; options: ProcessingOptions; createdAt: number };
type AuthUser = { email: string; name: string; createdAt: number };

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ERROR_MESSAGES = {
  'file-size': '파일 용량이 너무 큽니다. 10MB 이하 이미지로 다시 업로드해주세요.',
  'file-type': 'JPG, PNG, WebP 형식만 업로드할 수 있습니다.',
  'ai-failed': '배경 제거에 실패했습니다. 이미지를 다시 업로드하거나 잠시 후 재시도해주세요.',
  network: '연결이 불안정합니다. 인터넷 상태를 확인한 뒤 다시 시도해주세요.',
} as const;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const BACKGROUND_SAMPLE_STRIDE = 6;
const BACKGROUND_COLOR_BUCKET = 16;
const CHECKER_LIGHT_THRESHOLD = 220;
const CHECKER_NEUTRAL_THRESHOLD = 22;
const defaultOptions: ProcessingOptions = { mode: 'basic', smoothEdges: true, autoTrim: true, keepOriginalSize: true, strength: 36 };
const stageLabels: Record<ProcessingStage, string> = { idle: '대기 중', uploading: '업로드 중', analyzing: 'AI 분석 중', removing: '배경 제거 중', generating: '결과 생성 중', done: '완료' };
const toolLabels: Record<EditTool, string> = { strength: '배경 제거 강도 조정', eraser: '지우개', restore: '복원 브러시', crop: '이미지 자르기', padding: '여백 추가/제거', filename: '파일명 수정' };
type RgbColor = { r: number; g: number; b: number };

function validateFile(file: File): AppError | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return { type: 'file-type', message: ERROR_MESSAGES['file-type'] };
  if (file.size > MAX_FILE_SIZE) return { type: 'file-size', message: ERROR_MESSAGES['file-size'] };
  return null;
}

async function removeBackground(file: File, options: ProcessingOptions, onStageChange?: (stage: ProcessingStage, progress?: string) => void): Promise<string> {
  const steps: Array<{ stage: ProcessingStage; delay: number }> = [
    { stage: 'uploading', delay: 300 }, { stage: 'analyzing', delay: 350 }, { stage: 'removing', delay: 350 }, { stage: 'generating', delay: 250 },
  ];
  let resultUrl = '';
  for (const step of steps) {
    onStageChange?.(step.stage);
    if (step.stage === 'removing') resultUrl = await removeBackgroundLocally(file, options);
    await wait(step.delay);
  }
  onStageChange?.('done');
  return resultUrl;
}

function loadImage(imageUrl: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.')); image.src = imageUrl; }); }
async function loadFileImage(file: File) { const url = URL.createObjectURL(file); try { return await loadImage(url); } finally { URL.revokeObjectURL(url); } }
function imageDataToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> { return new Promise((resolve, reject) => { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('이미지 파일 생성에 실패했습니다.')), type, quality); }); }
async function canvasToObjectUrl(canvas: HTMLCanvasElement, type = 'image/png', quality?: number) { return URL.createObjectURL(await imageDataToBlob(canvas, type, quality)); }

async function removeBackgroundLocally(file: File, options: ProcessingOptions): Promise<string> {
  const image = await loadFileImage(file);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth || image.width;
  sourceCanvas.height = image.naturalHeight || image.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('Canvas를 생성할 수 없습니다.');
  sourceContext.drawImage(image, 0, 0);
  const imageData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const backgroundColors = detectBackgroundColors(imageData);
  const backgroundMask = createBackgroundMask(imageData, backgroundColors, options.strength);
  applyTransparency(imageData, backgroundMask, options.smoothEdges);
  const outputCanvas = options.autoTrim && !options.keepOriginalSize ? trimTransparentPixels(imageData) : sourceCanvas;
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw new Error('Canvas를 생성할 수 없습니다.');
  if (outputCanvas === sourceCanvas) outputContext.putImageData(imageData, 0, 0);
  return canvasToObjectUrl(outputCanvas);
}

function detectBackgroundColors(imageData: ImageData): RgbColor[] {
  const { data, width, height } = imageData;
  const counts = new Map<string, { color: RgbColor; count: number }>();
  const addSample = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    const key = `${Math.round(color.r / BACKGROUND_COLOR_BUCKET)},${Math.round(color.g / BACKGROUND_COLOR_BUCKET)},${Math.round(color.b / BACKGROUND_COLOR_BUCKET)}`;
    const current = counts.get(key);
    counts.set(key, { color, count: (current?.count || 0) + 1 });
  };
  for (let x = 0; x < width; x += BACKGROUND_SAMPLE_STRIDE) { addSample(x, 0); addSample(x, height - 1); }
  for (let y = 0; y < height; y += BACKGROUND_SAMPLE_STRIDE) { addSample(0, y); addSample(width - 1, y); }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(({ color }) => color);
}

function createBackgroundMask(imageData: ImageData, backgroundColors: RgbColor[], strength: number) {
  const { width, height } = imageData;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel] || !isBackgroundPixel(imageData, pixel, backgroundColors, strength)) return;
    visited[pixel] = 1;
    queue.push(pixel);
  };
  for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
  for (let index = 0; index < queue.length; index += 1) {
    const pixel = queue[index];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1);
  }
  return visited;
}

function isBackgroundPixel(imageData: ImageData, pixel: number, backgroundColors: RgbColor[], strength: number) {
  const index = pixel * 4;
  const data = imageData.data;
  const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const average = (color.r + color.g + color.b) / 3;
  if (average > CHECKER_LIGHT_THRESHOLD && max - min < CHECKER_NEUTRAL_THRESHOLD + strength / 8) return true;
  return backgroundColors.some((background) => colorDistance(color, background) < strength);
}

function colorDistance(a: RgbColor, b: RgbColor) { const r = a.r - b.r; const g = a.g - b.g; const bDiff = a.b - b.b; return Math.sqrt(r * r + g * g + bDiff * bDiff); }
function applyTransparency(imageData: ImageData, backgroundMask: Uint8Array, smoothEdges: boolean) {
  const { data, width, height } = imageData;
  for (let pixel = 0; pixel < backgroundMask.length; pixel += 1) if (backgroundMask[pixel]) data[pixel * 4 + 3] = 0;
  if (!smoothEdges) return;
  const nextAlpha = new Uint8ClampedArray(width * height);
  for (let pixel = 0; pixel < nextAlpha.length; pixel += 1) nextAlpha[pixel] = data[pixel * 4 + 3];
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const pixel = y * width + x;
    if (backgroundMask[pixel]) continue;
    const touchesBackground = backgroundMask[pixel - 1] || backgroundMask[pixel + 1] || backgroundMask[pixel - width] || backgroundMask[pixel + width];
    if (touchesBackground) nextAlpha[pixel] = Math.min(nextAlpha[pixel], 225);
  }
  for (let pixel = 0; pixel < nextAlpha.length; pixel += 1) data[pixel * 4 + 3] = nextAlpha[pixel];
}

function trimTransparentPixels(imageData: ImageData) {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] !== 0) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (maxX < minX || maxY < minY) return imageDataToCanvas(imageData);
  const output = document.createElement('canvas');
  output.width = maxX - minX + 1;
  output.height = maxY - minY + 1;
  output.getContext('2d')?.putImageData(imageData, -minX, -minY);
  return output;
}
function imageDataToCanvas(imageData: ImageData) { const canvas = document.createElement('canvas'); canvas.width = imageData.width; canvas.height = imageData.height; canvas.getContext('2d')?.putImageData(imageData, 0, 0); return canvas; }
async function generateDownloadBlob(imageUrl: string, format: DownloadFormat): Promise<Blob> { const image = await loadImage(imageUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas를 생성할 수 없습니다.'); if (format === 'jpg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); } context.drawImage(image, 0, 0); const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`; return imageDataToBlob(canvas, mimeType, 0.95); }
async function generateQRCode(downloadUrl: string): Promise<string> { return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(downloadUrl)}`; }
function formatSize(size: number) { return `${(size / 1024 / 1024).toFixed(2)}MB`; }

function saveRecords(records: ResultRecord[]) {
  const last = records[0];
  sessionStorage.setItem('make-real-png:last-result', JSON.stringify(last));
  sessionStorage.setItem('make-real-png:last-batch', JSON.stringify(records));
  records.forEach((record) => sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record)));
}
function readBatch(): ResultRecord[] { const raw = sessionStorage.getItem('make-real-png:last-batch'); if (raw) return JSON.parse(raw) as ResultRecord[]; const single = readRecord(); return single ? [single] : []; }
function readRecord(id?: string): ResultRecord | null { const key = id ? `make-real-png:result:${id}` : 'make-real-png:last-result'; const raw = sessionStorage.getItem(key); return raw ? (JSON.parse(raw) as ResultRecord) : null; }
function updateStoredRecord(record: ResultRecord) {
  sessionStorage.setItem('make-real-png:last-result', JSON.stringify(record));
  sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record));
  const batch = readBatch().map((item) => item.id === record.id ? record : item);
  sessionStorage.setItem('make-real-png:last-batch', JSON.stringify(batch));
}
function saveVault(user: AuthUser) { const batch = readBatch(); localStorage.setItem('make-real-png:user', JSON.stringify(user)); localStorage.setItem(`make-real-png:vault:${user.email}`, JSON.stringify(batch)); }
function downloadBlob(blob: Blob, fileName: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); }

const APP_BASENAME = window.location.pathname.split('/').filter(Boolean)[0] === 'make-real-png' ? '/make-real-png' : '';
function toAppPath(pathname: string) { const path = pathname.startsWith(APP_BASENAME) ? pathname.slice(APP_BASENAME.length) || '/' : pathname; return path.startsWith('/') ? path : `/${path}`; }
function toBrowserPath(appPath: string) { const normalizedPath = appPath.startsWith('/') ? appPath : `/${appPath}`; return `${APP_BASENAME}${normalizedPath === '/' ? '/' : normalizedPath}`; }
function navigateTo(to: string) { window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); }

function Link({ to, className, children }: { to: string; className?: string; children?: any }) { return <a href={toBrowserPath(to)} className={className} onClick={(event: MouseEvent) => { event.preventDefault(); navigateTo(to); }}>{children}</a>; }
function useNavigate() { return navigateTo; }
function useParams(): { id?: string } { const match = toAppPath(window.location.pathname).match(/\/mobile-download\/([^/]+)/); return { id: match?.[1] }; }

function App() {
  const [path, setPath] = React.useState(toAppPath(window.location.pathname));
  React.useEffect(() => {
    const onNavigate = (event: Event) => { const to = (event as CustomEvent<string>).detail; window.history.pushState({}, '', toBrowserPath(to)); setPath(toAppPath(window.location.pathname)); };
    const onPop = () => setPath(toAppPath(window.location.pathname));
    window.addEventListener('app:navigate', onNavigate); window.addEventListener('popstate', onPop);
    return () => { window.removeEventListener('app:navigate', onNavigate); window.removeEventListener('popstate', onPop); };
  }, []);
  if (path.startsWith('/mobile-download/')) return <MobileDownloadPage />;
  if (path === '/result') return <ResultPage />;
  if (path === '/auth') return <AuthPage />;
  return <LandingPage />;
}

function LandingPage() {
  const navigate = useNavigate();
  const [uploadedFiles, setUploadedFiles] = React.useState<File[]>([]);
  const [originalUrls, setOriginalUrls] = React.useState<string[]>([]);
  const [options, setOptions] = React.useState(defaultOptions);
  const [stage, setStage] = React.useState<ProcessingStage>('idle');
  const [progress, setProgress] = React.useState('');
  const [error, setError] = React.useState<AppError | null>(null);

  const handleFiles = (files?: FileList | File[] | null) => {
    const nextFiles = Array.from(files || []);
    if (!nextFiles.length) return;
    const invalid = nextFiles.map(validateFile).find(Boolean);
    if (invalid) { setError(invalid); return; }
    originalUrls.forEach((url) => URL.revokeObjectURL(url));
    setError(null);
    setUploadedFiles(nextFiles);
    setOriginalUrls(nextFiles.map((file) => URL.createObjectURL(file)));
  };
  const removeFile = (index: number) => { URL.revokeObjectURL(originalUrls[index]); setUploadedFiles((files) => files.filter((_, i) => i !== index)); setOriginalUrls((urls) => urls.filter((_, i) => i !== index)); };
  const startProcess = async () => {
    if (!uploadedFiles.length) return;
    try {
      const batchId = crypto.randomUUID();
      const records: ResultRecord[] = [];
      for (let index = 0; index < uploadedFiles.length; index += 1) {
        const file = uploadedFiles[index];
        setProgress(`${index + 1}/${uploadedFiles.length} · ${file.name}`);
        const resultUrl = await removeBackground(file, options, setStage);
        records.push({ id: crypto.randomUUID(), batchId, originalUrl: originalUrls[index], resultUrl, fileName: file.name, options, createdAt: Date.now() });
      }
      saveRecords(records);
      navigate('/result');
    } catch {
      setError({ type: 'ai-failed', message: ERROR_MESSAGES['ai-failed'] });
      setStage('idle');
      setProgress('');
    }
  };
  const reset = () => { originalUrls.forEach((url) => URL.revokeObjectURL(url)); setUploadedFiles([]); setOriginalUrls([]); setError(null); setStage('idle'); setProgress(''); };
  if (stage !== 'idle' && stage !== 'done') return <ProcessingScreen stage={stage} progress={progress} />;
  return <main className="min-h-screen bg-slate-50 text-slate-950"><section className="mx-auto grid max-w-7xl gap-10 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16"><div className="flex flex-col justify-center"><span className="w-fit rounded-full bg-blue-100 px-4 py-2 text-sm font-semibold text-blue-700">QR 모바일 저장 특화 MVP</span><h1 className="mt-6 text-4xl font-extrabold tracking-tight md:text-6xl">AI 배경 제거 후, 모바일 저장까지 한 번에</h1><p className="mt-5 text-lg leading-8 text-slate-600">이미지를 여러 장 업로드하면 가장자리 배경색을 감지해 실제 투명 PNG 결과를 만들고 PNG/WebP/JPG/ZIP 다운로드와 QR코드 모바일 저장 링크를 제공합니다.</p><div className="mt-8 flex flex-wrap gap-3"><a href="#upload" className="rounded-2xl bg-blue-600 px-6 py-4 font-bold text-white shadow-lg shadow-blue-200">이미지 업로드하기</a><button onClick={() => createSample((file) => handleFiles([file]))} className="rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800">샘플 이미지로 체험하기</button><Link to="/auth" className="rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800">회원가입/로그인</Link></div><div className="mt-8 grid gap-3 text-sm text-slate-500 sm:grid-cols-3"><Info label="지원 형식" value="JPG, PNG, WebP" /><Info label="최대 용량" value="10MB/장" /><Info label="다중 업로드" value="여러 장 동시 처리" /></div></div><div id="upload" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/70"><UploadBox onFiles={handleFiles} />{error && <ErrorState error={error} onRetry={() => setError(null)} onNew={reset} />}{uploadedFiles.length > 0 && <FilePreviewList files={uploadedFiles} imageUrls={originalUrls} onRemove={removeFile} />}<ProcessingOptionsPanel options={options} onChange={setOptions} /><button disabled={!uploadedFiles.length} onClick={startProcess} className="mt-5 w-full rounded-2xl bg-slate-950 px-6 py-4 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">{uploadedFiles.length > 1 ? `${uploadedFiles.length}개 이미지 배경 제거 시작` : '배경 제거 시작'}</button></div></section></main>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="font-bold text-slate-900">{label}</p><p>{value}</p></div>; }
function UploadBox({ onFiles }: { onFiles: (files?: FileList | File[] | null) => void }) { return <label onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }} className="flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-300 bg-blue-50/60 p-10 text-center"><span className="text-5xl">🖼️</span><strong className="mt-4 text-xl">이미지를 여러 장 드래그 앤 드롭하세요</strong><span className="mt-2 text-slate-500">또는 파일 선택 업로드 버튼을 눌러 다중 선택하세요.</span><span className="mt-5 rounded-xl bg-blue-600 px-5 py-3 font-bold text-white">파일 선택 업로드</span><input className="sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => onFiles(e.target.files)} /></label>; }
function FilePreviewList({ files, imageUrls, onRemove }: { files: File[]; imageUrls: string[]; onRemove: (index: number) => void }) { return <div className="mt-5 grid gap-3"><div className="flex items-center justify-between"><p className="font-bold">업로드된 이미지 {files.length}개</p><p className="text-sm text-emerald-600">전체 검증 완료</p></div>{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center gap-4 rounded-2xl border border-slate-200 p-4"><img src={imageUrls[index]} className="h-20 w-20 rounded-xl object-cover" /><div className="min-w-0 flex-1"><p className="truncate font-bold">{file.name}</p><p className="text-sm text-slate-500">{formatSize(file.size)}</p></div><button onClick={() => onRemove(index)} className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold">제거</button></div>)}</div>; }
function ProcessingOptionsPanel({ options, onChange }: { options: ProcessingOptions; onChange: (options: ProcessingOptions) => void }) { const modes = [{ id: 'basic', label: '기본 배경 제거' }, { id: 'person', label: '인물 우선 모드' }, { id: 'product', label: '제품/사물 우선 모드' }] as const; const toggles = [{ key: 'smoothEdges', label: '가장자리 부드럽게' }, { key: 'autoTrim', label: '여백 자동 정리' }, { key: 'keepOriginalSize', label: '원본 크기 유지' }] as const; return <section className="mt-5 rounded-2xl bg-slate-50 p-4"><h2 className="font-bold">처리 옵션</h2><div className="mt-3 grid gap-2">{modes.map((mode) => <button key={mode.id} onClick={() => onChange({ ...options, mode: mode.id })} className={`rounded-xl border p-3 text-left ${options.mode === mode.id ? 'border-blue-500 bg-blue-50 font-bold text-blue-700' : 'border-slate-200 bg-white'}`}>{mode.label}</button>)}</div><label className="mt-4 block rounded-xl bg-white p-3 text-sm font-semibold">배경 제거 강도: {options.strength}<input type="range" min="18" max="70" value={options.strength} onChange={(e) => onChange({ ...options, strength: Number(e.target.value) })} className="mt-2 w-full" /></label><div className="mt-4 grid gap-2 sm:grid-cols-3">{toggles.map((toggle) => <label key={toggle.key} className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm"><input type="checkbox" checked={options[toggle.key]} onChange={(e) => onChange({ ...options, [toggle.key]: e.target.checked })} />{toggle.label}</label>)}</div></section>; }
function ProcessingScreen({ stage, progress }: { stage: ProcessingStage; progress?: string }) { const steps: ProcessingStage[] = ['uploading', 'analyzing', 'removing', 'generating']; const current = steps.indexOf(stage); return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-5 text-white"><div className="w-full max-w-xl rounded-3xl bg-white/10 p-8"><div className="mx-auto h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-blue-400" /><h1 className="mt-6 text-center text-3xl font-extrabold">{stageLabels[stage]}</h1>{progress && <p className="mt-2 text-center text-blue-100">{progress}</p>}<div className="mt-8 space-y-3">{steps.map((step, index) => <div key={step} className={`rounded-2xl p-4 ${index <= current ? 'bg-blue-500' : 'bg-white/10'}`}>{stageLabels[step]}</div>)}</div></div></main>; }

function ResultPage() {
  const navigate = useNavigate();
  const [records, setRecords] = React.useState<ResultRecord[]>(readBatch());
  const [selectedId, setSelectedId] = React.useState(records[0]?.id || '');
  const [background, setBackground] = React.useState<BackgroundMode>('transparent');
  const [zoom, setZoom] = React.useState(false);
  const [activeTool, setActiveTool] = React.useState<EditTool>('strength');
  const [complete, setComplete] = React.useState(false);
  const selected = records.find((record) => record.id === selectedId) || records[0];
  if (!selected) return <MissingResult />;
  const updateSelected = (record: ResultRecord) => { updateStoredRecord(record); setRecords((items) => items.map((item) => item.id === record.id ? record : item)); };
  return <main className="min-h-screen bg-slate-50 px-5 py-8"><div className="mx-auto max-w-7xl"><header className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="font-bold text-blue-600">배경 제거 완료</p><h1 className="text-3xl font-extrabold">결과 확인 및 다운로드</h1><p className="mt-1 text-slate-500">{records.length}개 결과가 보관 대기 중입니다.</p></div><div className="flex flex-wrap gap-2"><Link to="/auth" className="rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white">회원가입/로그인하고 결과 보관</Link><button onClick={() => navigate('/')} className="rounded-2xl bg-white px-5 py-3 font-bold shadow">새 이미지 업로드</button></div></header>{records.length > 1 && <ResultStrip records={records} selectedId={selected.id} onSelect={setSelectedId} />}<div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]"><section className="space-y-6"><CompareSlider originalUrl={selected.originalUrl} resultUrl={selected.resultUrl} background={background} zoom={zoom} /><BackgroundPreviewToggle value={background} onChange={setBackground} zoom={zoom} onZoom={setZoom} /><EditToolbar activeTool={activeTool} onAction={setActiveTool} /><EditPanel record={selected} activeTool={activeTool} onUpdate={updateSelected} /><div className="flex flex-wrap gap-3"><button onClick={() => navigate('/')} className="rounded-2xl border bg-white px-5 py-3 font-bold">다시 처리하기</button><button onClick={() => navigate('/')} className="rounded-2xl border bg-white px-5 py-3 font-bold">새 이미지 업로드</button></div></section><aside className="space-y-6"><DownloadPanel record={selected} records={records} onComplete={() => setComplete(true)} /><QRDownloadPanel record={selected} /><CompletionPanel show={complete} onResult={() => setComplete(false)} /></aside></div></div></main>;
}
function ResultStrip({ records, selectedId, onSelect }: { records: ResultRecord[]; selectedId: string; onSelect: (id: string) => void }) { return <section className="mt-6 rounded-3xl bg-white p-4 shadow"><h2 className="font-bold">다중 업로드 결과</h2><div className="mt-3 flex gap-3 overflow-x-auto pb-2">{records.map((record, index) => <button key={record.id} onClick={() => onSelect(record.id)} className={`min-w-40 rounded-2xl border p-3 text-left ${record.id === selectedId ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><img src={record.resultUrl} className="checker h-24 w-full rounded-xl object-contain" /><p className="mt-2 truncate text-sm font-bold">{index + 1}. {record.fileName}</p></button>)}</div></section>; }
function CompareSlider({ originalUrl, resultUrl, background, zoom }: { originalUrl: string; resultUrl: string; background: BackgroundMode; zoom: boolean }) { const [split, setSplit] = React.useState(50); const bgClass = background === 'transparent' ? 'checker' : background === 'white' ? 'bg-white' : 'bg-slate-950'; return <div className={`relative overflow-hidden rounded-3xl border border-slate-200 ${bgClass}`}><img src={resultUrl} className={`mx-auto h-[460px] w-full object-contain ${zoom ? 'scale-125' : ''}`} /><div className="absolute inset-0 overflow-hidden" style={{ width: `${split}%` }}><img src={originalUrl} className={`h-[460px] w-full max-w-none object-contain ${zoom ? 'scale-125' : ''}`} /></div><input aria-label="원본 결과 비교 슬라이더" type="range" min="0" max="100" value={split} onChange={(e) => setSplit(Number(e.target.value))} className="absolute bottom-5 left-1/2 w-3/4 -translate-x-1/2" /><span className="absolute left-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold">원본</span><span className="absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold">결과</span></div>; }
function BackgroundPreviewToggle({ value, onChange, zoom, onZoom }: { value: BackgroundMode; onChange: (value: BackgroundMode) => void; zoom: boolean; onZoom: (value: boolean) => void }) { return <div className="rounded-3xl bg-white p-4 shadow"><h2 className="font-bold">배경 미리보기</h2><div className="mt-3 flex flex-wrap gap-2">{(['transparent', 'white', 'black'] as BackgroundMode[]).map((mode) => <button key={mode} onClick={() => onChange(mode)} className={`rounded-xl px-4 py-2 font-bold ${value === mode ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>{mode === 'transparent' ? '투명(체크무늬 미리보기)' : mode === 'white' ? '흰 배경' : '검은 배경'}</button>)}<button onClick={() => onZoom(!zoom)} className="rounded-xl bg-slate-900 px-4 py-2 font-bold text-white">확대해서 가장자리 확인</button></div></div>; }
function EditToolbar({ activeTool, onAction }: { activeTool: EditTool; onAction: (tool: EditTool) => void }) { return <div className="rounded-3xl bg-white p-4 shadow"><h2 className="font-bold">간단 편집 UI</h2><div className="mt-3 grid gap-2 sm:grid-cols-3">{(Object.keys(toolLabels) as EditTool[]).map((tool) => <button key={tool} onClick={() => onAction(tool)} className={`rounded-xl border px-4 py-3 font-semibold hover:bg-slate-50 ${activeTool === tool ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200'}`}>{toolLabels[tool]}</button>)}</div></div>; }

function EditPanel({ record, activeTool, onUpdate }: { record: ResultRecord; activeTool: EditTool; onUpdate: (record: ResultRecord) => void }) {
  const [value, setValue] = React.useState(record.options.strength);
  const [brush, setBrush] = React.useState(34);
  const [crop, setCrop] = React.useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [padding, setPadding] = React.useState(40);
  const [name, setName] = React.useState(record.fileName);
  const [busy, setBusy] = React.useState(false);
  const apply = async (job: () => Promise<ResultRecord>) => { setBusy(true); try { onUpdate(await job()); } finally { setBusy(false); } };
  if (activeTool === 'strength') return <section className="rounded-3xl bg-white p-5 shadow"><h3 className="font-extrabold">배경 제거 강도 조정</h3><p className="mt-2 text-sm text-slate-500">값이 높을수록 가장자리와 배경색을 더 넓게 제거합니다.</p><input type="range" min="18" max="70" value={value} onChange={(e) => setValue(Number(e.target.value))} className="mt-4 w-full" /><button disabled={busy} onClick={() => apply(async () => ({ ...record, options: { ...record.options, strength: value }, resultUrl: await rebuildWithStrength(record.originalUrl, { ...record.options, strength: value }) }))} className="mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">강도 {value}로 다시 적용</button></section>;
  if (activeTool === 'eraser' || activeTool === 'restore') return <BrushEditor record={record} mode={activeTool} brush={brush} onBrush={setBrush} onUpdate={onUpdate} />;
  if (activeTool === 'crop') return <section className="rounded-3xl bg-white p-5 shadow"><h3 className="font-extrabold">이미지 자르기</h3><div className="mt-3 grid grid-cols-2 gap-2">{(['top', 'right', 'bottom', 'left'] as const).map((side) => <label key={side} className="rounded-xl bg-slate-50 p-3 text-sm font-semibold">{side}<input type="number" min="0" value={crop[side]} onChange={(e) => setCrop({ ...crop, [side]: Math.max(0, Number(e.target.value)) })} className="mt-1 w-full rounded-lg border p-2" /></label>)}</div><button disabled={busy} onClick={() => apply(async () => ({ ...record, resultUrl: await cropImage(record.resultUrl, crop) }))} className="mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">자르기 적용</button></section>;
  if (activeTool === 'padding') return <section className="rounded-3xl bg-white p-5 shadow"><h3 className="font-extrabold">여백 추가/제거</h3><label className="mt-3 block text-sm font-semibold">추가할 투명 여백 {padding}px<input type="range" min="0" max="240" value={padding} onChange={(e) => setPadding(Number(e.target.value))} className="mt-2 w-full" /></label><div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} onClick={() => apply(async () => ({ ...record, resultUrl: await padImage(record.resultUrl, padding) }))} className="rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">여백 추가</button><button disabled={busy} onClick={() => apply(async () => ({ ...record, resultUrl: await trimImage(record.resultUrl) }))} className="rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white">투명 여백 제거</button></div></section>;
  return <section className="rounded-3xl bg-white p-5 shadow"><h3 className="font-extrabold">파일명 수정</h3><input value={name} onChange={(e) => setName(e.target.value)} className="mt-3 w-full rounded-xl border p-3" /><button onClick={() => onUpdate({ ...record, fileName: name.trim() || record.fileName })} className="mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">파일명 저장</button></section>;
}

function BrushEditor({ record, mode, brush, onBrush, onUpdate }: { record: ResultRecord; mode: 'eraser' | 'restore'; brush: number; onBrush: (value: number) => void; onUpdate: (record: ResultRecord) => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [drawing, setDrawing] = React.useState(false);
  React.useEffect(() => { (async () => { const result = await loadImage(record.resultUrl); const canvas = canvasRef.current; const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return; canvas.width = result.naturalWidth || result.width; canvas.height = result.naturalHeight || result.height; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(result, 0, 0); setReady(true); })(); }, [record.id, record.resultUrl]);
  const paint = async (event: any) => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect(); const x = (event.clientX - rect.left) * (canvas.width / rect.width); const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, brush, 0, Math.PI * 2); ctx.clip();
    if (mode === 'eraser') { ctx.clearRect(x - brush, y - brush, brush * 2, brush * 2); }
    else { const original = await loadImage(record.originalUrl); ctx.drawImage(original, 0, 0, canvas.width, canvas.height); }
    ctx.restore();
  };
  const save = async () => { const canvas = canvasRef.current; if (!canvas) return; onUpdate({ ...record, resultUrl: await canvasToObjectUrl(canvas) }); };
  return <section className="rounded-3xl bg-white p-5 shadow"><h3 className="font-extrabold">{mode === 'eraser' ? '지우개' : '복원 브러시'}</h3><p className="mt-2 text-sm text-slate-500">캔버스 위에서 드래그해 {mode === 'eraser' ? '투명하게 지우거나' : '원본 픽셀을 되살리고'} 저장하세요.</p><label className="mt-3 block text-sm font-semibold">브러시 크기 {brush}px<input type="range" min="8" max="120" value={brush} onChange={(e) => onBrush(Number(e.target.value))} className="mt-2 w-full" /></label><canvas ref={canvasRef} onPointerDown={(e) => { setDrawing(true); paint(e); }} onPointerMove={(e) => drawing && paint(e)} onPointerUp={() => setDrawing(false)} onPointerLeave={() => setDrawing(false)} className="checker mt-4 max-h-[420px] w-full touch-none rounded-2xl border object-contain" /><button disabled={!ready} onClick={save} className="mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white disabled:bg-slate-300">편집 저장</button></section>;
}

async function rebuildWithStrength(originalUrl: string, options: ProcessingOptions) { const image = await loadImage(originalUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas를 생성할 수 없습니다.'); ctx.drawImage(image, 0, 0); const blob = await imageDataToBlob(canvas); return removeBackgroundLocally(new File([blob], 'edited-source.png', { type: 'image/png' }), options); }
async function cropImage(url: string, crop: { top: number; right: number; bottom: number; left: number }) { const image = await loadImage(url); const width = Math.max(1, (image.naturalWidth || image.width) - crop.left - crop.right); const height = Math.max(1, (image.naturalHeight || image.height) - crop.top - crop.bottom); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d')?.drawImage(image, crop.left, crop.top, width, height, 0, 0, width, height); return canvasToObjectUrl(canvas); }
async function padImage(url: string, padding: number) { const image = await loadImage(url); const canvas = document.createElement('canvas'); canvas.width = (image.naturalWidth || image.width) + padding * 2; canvas.height = (image.naturalHeight || image.height) + padding * 2; canvas.getContext('2d')?.drawImage(image, padding, padding); return canvasToObjectUrl(canvas); }
async function trimImage(url: string) { const image = await loadImage(url); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas를 생성할 수 없습니다.'); ctx.drawImage(image, 0, 0); return canvasToObjectUrl(trimTransparentPixels(ctx.getImageData(0, 0, canvas.width, canvas.height))); }

function DownloadPanel({ record, records, onComplete }: { record: ResultRecord; records: ResultRecord[]; onComplete: () => void }) { const baseName = record.fileName.replace(/\.[^/.]+$/, '') || 'result'; const handleDownload = async (format: DownloadFormat) => { const blob = await generateDownloadBlob(record.resultUrl, format); downloadBlob(blob, `${baseName}-background-removed.${format}`); onComplete(); }; const handleZip = async () => { downloadBlob(await createZip(records), `make-real-png-${records.length}-results.zip`); onComplete(); }; return <section className="rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-extrabold">다운로드</h2><p className="mt-2 text-sm text-slate-500">투명 미리보기의 체크무늬는 파일에 저장되지 않습니다.</p><div className="mt-4 grid gap-3"><button onClick={() => handleDownload('png')} className="rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">PNG 투명 배경 다운로드</button><button onClick={() => handleDownload('webp')} className="rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white">WebP 다운로드</button><button onClick={() => handleDownload('jpg')} className="rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200">JPG 흰 배경 다운로드</button><button onClick={handleZip} disabled={records.length < 2} className="rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500">ZIP 다운로드 · {records.length}개 결과</button></div></section>; }
async function createZip(records: ResultRecord[]) { const files = await Promise.all(records.map(async (record, index) => ({ name: `${String(index + 1).padStart(2, '0')}-${(record.fileName.replace(/\.[^/.]+$/, '') || 'result')}.png`, data: new Uint8Array(await (await generateDownloadBlob(record.resultUrl, 'png')).arrayBuffer()) }))); const encoder = new TextEncoder(); const chunks: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0; const u16 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]); const u32 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); const concat = (...parts: Uint8Array[]) => { const length = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(length); let cursor = 0; parts.forEach((part) => { output.set(part, cursor); cursor += part.length; }); return output; }; files.forEach((file) => { const name = encoder.encode(file.name); const crc = crc32(file.data); const local = concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), name, file.data); chunks.push(local); central.push(concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name)); offset += local.length; }); const centralSize = central.reduce((sum, part) => sum + part.length, 0); return new Blob(([...chunks, ...central, concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0))] as BlobPart[]), { type: 'application/zip' }); }
function crc32(data: Uint8Array) { let crc = -1; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function QRDownloadPanel({ record }: { record: ResultRecord }) { const [qr, setQr] = React.useState(''); const mobileUrl = React.useMemo(() => `${window.location.origin}${toBrowserPath(`/mobile-download/${record.id}`)}`, [record.id]); const createQr = async () => setQr(await generateQRCode(mobileUrl)); return <section className="rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-extrabold">QR 모바일 저장</h2><p className="mt-2 text-sm text-slate-500">모바일에서 QR코드를 스캔하면 선택한 결과 이미지를 저장할 수 있습니다.</p><button onClick={createQr} className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white">QR코드 생성</button>{qr && <div className="mt-4 rounded-2xl border p-4 text-center"><img src={qr} className="mx-auto" /><p className="mt-3 break-all text-xs text-slate-500">{mobileUrl}</p></div>}</section>; }
function CompletionPanel({ show, onResult }: { show: boolean; onResult: () => void }) { const navigate = useNavigate(); if (!show) return null; return <section className="rounded-3xl bg-blue-50 p-5"><h2 className="text-xl font-extrabold text-blue-900">완료되었습니다</h2><div className="mt-4 grid gap-2"><button onClick={() => navigate('/')} className="rounded-xl bg-blue-600 px-4 py-3 font-bold text-white">다른 이미지 업로드</button><button onClick={() => navigate('/')} className="rounded-xl bg-white px-4 py-3 font-bold">같은 옵션으로 새 이미지 처리</button><button onClick={onResult} className="rounded-xl bg-white px-4 py-3 font-bold">결과 다시 보기</button><button onClick={() => navigator.share?.({ title: 'Make Real PNG', url: location.href })} className="rounded-xl bg-white px-4 py-3 font-bold">서비스 공유하기</button><button onClick={() => navigate('/auth')} className="rounded-xl bg-slate-950 px-4 py-3 font-bold text-white">회원가입/로그인하고 결과 보관</button></div></section>; }
function AuthPage() { const navigate = useNavigate(); const [mode, setMode] = React.useState<'signup' | 'login'>('signup'); const [email, setEmail] = React.useState(''); const [name, setName] = React.useState(''); const [saved, setSaved] = React.useState(false); const submit = (event: Event) => { event.preventDefault(); saveVault({ email, name: name || email.split('@')[0], createdAt: Date.now() }); setSaved(true); }; return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5"><section className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-xl"><p className="font-bold text-blue-600">결과 보관 계정</p><h1 className="mt-2 text-3xl font-extrabold">회원가입/로그인</h1><p className="mt-3 text-slate-500">MVP에서는 브라우저 로컬 저장소에 계정 상태와 결과 묶음을 보관합니다. 서버 연동 시 이 화면을 실제 인증 API와 연결하면 됩니다.</p><div className="mt-5 grid grid-cols-2 gap-2"><button onClick={() => setMode('signup')} className={`rounded-xl p-3 font-bold ${mode === 'signup' ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>회원가입</button><button onClick={() => setMode('login')} className={`rounded-xl p-3 font-bold ${mode === 'login' ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>로그인</button></div><form onSubmit={submit} className="mt-5 grid gap-3"><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일" className="rounded-xl border p-3" />{mode === 'signup' && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" className="rounded-xl border p-3" />}<input required type="password" minLength={6} placeholder="비밀번호" className="rounded-xl border p-3" /><button className="rounded-2xl bg-slate-950 px-5 py-4 font-bold text-white">{mode === 'signup' ? '회원가입하고 결과 보관' : '로그인하고 결과 보관'}</button></form>{saved && <div className="mt-5 rounded-2xl bg-emerald-50 p-4 text-emerald-700"><p className="font-bold">결과가 보관되었습니다.</p><p className="text-sm">보관된 결과 {readBatch().length}개를 이 브라우저에서 다시 확인할 수 있습니다.</p></div>}<button onClick={() => navigate('/result')} className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">결과 페이지로 돌아가기</button><Link to="/" className="mt-3 block text-center text-sm font-bold text-slate-500">처음으로</Link></section></main>; }
function ErrorState({ error, onRetry, onNew }: { error: AppError; onRetry: () => void; onNew: () => void }) { return <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4"><p className="font-bold text-red-700">{error.message}</p><div className="mt-3 flex gap-2"><button onClick={onRetry} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white">다시 시도</button><button onClick={onNew} className="rounded-xl bg-white px-4 py-2 font-bold text-red-700">새 이미지 업로드</button></div></div>; }
function MobileDownloadPage() { const { id } = useParams(); const record = readRecord(id); if (!record) return <MissingResult />; return <main className="min-h-screen bg-slate-950 p-5 text-white"><section className="mx-auto max-w-md rounded-3xl bg-white p-5 text-slate-950"><p className="font-bold text-emerald-600">모바일 다운로드 페이지</p><h1 className="mt-2 text-2xl font-extrabold">결과 이미지를 길게 눌러 저장하세요</h1><img src={record.resultUrl} className="checker mt-5 w-full rounded-2xl object-contain" /><p className="mt-4 text-sm text-slate-500">iOS/Android 브라우저에서 이미지를 길게 누른 뒤 “사진에 저장” 또는 “이미지 다운로드”를 선택하세요.</p><Link to="/" className="mt-5 block rounded-2xl bg-blue-600 px-5 py-3 text-center font-bold text-white">다른 이미지 업로드</Link></section></main>; }
function MissingResult() { return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5"><div className="max-w-md rounded-3xl bg-white p-8 text-center shadow"><h1 className="text-2xl font-extrabold">결과를 찾을 수 없습니다</h1><p className="mt-3 text-slate-500">브라우저 메모리 기반 MVP라 새로고침 또는 24시간 만료 후에는 다시 업로드가 필요합니다.</p><Link to="/" className="mt-6 inline-block rounded-2xl bg-blue-600 px-6 py-3 font-bold text-white">새 이미지 업로드</Link></div></main>; }
function createSample(onFile: (file: File) => void) { const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600; const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.fillStyle = '#dbeafe'; ctx.fillRect(0, 0, 900, 600); ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(450, 260, 120, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#0f172a'; ctx.fillRect(310, 390, 280, 70); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('SAMPLE', 380, 435); canvas.toBlob((blob) => blob && onFile(new File([blob], 'sample-product.png', { type: 'image/png' })), 'image/png'); }

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
