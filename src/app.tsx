
type ProcessingMode = 'basic' | 'person' | 'product';
type ProcessingOptions = { mode: ProcessingMode; smoothEdges: boolean; autoTrim: boolean; keepOriginalSize: boolean; };
type ProcessingStage = 'idle' | 'uploading' | 'analyzing' | 'removing' | 'generating' | 'done';
type AppErrorType = 'file-size' | 'file-type' | 'ai-failed' | 'network';
type AppError = { type: AppErrorType; message: string };
type BackgroundMode = 'transparent' | 'white' | 'black';
type DownloadFormat = 'png' | 'webp' | 'jpg';
type ResultRecord = { id: string; originalUrl: string; resultUrl: string; fileName: string; options: ProcessingOptions; createdAt: number };

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ERROR_MESSAGES = {
  'file-size': '파일 용량이 너무 큽니다. 10MB 이하 이미지로 다시 업로드해주세요.',
  'file-type': 'JPG, PNG, WebP 형식만 업로드할 수 있습니다.',
  'ai-failed': '배경 제거에 실패했습니다. 이미지를 다시 업로드하거나 잠시 후 재시도해주세요.',
  network: '연결이 불안정합니다. 인터넷 상태를 확인한 뒤 다시 시도해주세요.',
} as const;

function validateFile(file: File): AppError | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return { type: 'file-type', message: ERROR_MESSAGES['file-type'] };
  if (file.size > MAX_FILE_SIZE) return { type: 'file-size', message: ERROR_MESSAGES['file-size'] };
  return null;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
async function removeBackground(file: File, options: ProcessingOptions, onStageChange?: (stage: ProcessingStage) => void): Promise<string> {
  const steps: Array<{ stage: ProcessingStage; delay: number }> = [
    { stage: 'uploading', delay: 700 }, { stage: 'analyzing', delay: 900 }, { stage: 'removing', delay: 1100 }, { stage: 'generating', delay: 800 },
  ];
  for (const step of steps) { onStageChange?.(step.stage); await wait(step.delay); }
  // TODO: 실제 서비스에서는 이 지점에서 AI 배경 제거 API를 호출하고 서버 저장 URL을 반환합니다.
  void options;
  onStageChange?.('done');
  return URL.createObjectURL(file);
}
function loadImage(imageUrl: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.')); image.src = imageUrl; }); }
async function generateDownloadBlob(imageUrl: string, format: DownloadFormat): Promise<Blob> { const image = await loadImage(imageUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas를 생성할 수 없습니다.'); if (format === 'jpg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); } context.drawImage(image, 0, 0); const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`; return new Promise((resolve, reject) => { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('다운로드 파일 생성에 실패했습니다.')), mimeType, 0.95); }); }
async function generateQRCode(downloadUrl: string): Promise<string> {
  // TODO: 운영 환경에서는 서버 저장 URL을 표준 QR 라이브러리 또는 백엔드에서 생성한 QR 이미지로 교체합니다.
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(downloadUrl)}`;
}
function resetFlow() { return { uploadedFile: null, originalUrl: '', resultUrl: '', error: null, stage: 'idle' as ProcessingStage, qrLink: '' }; }

function Link({ to, className, children }: { to: string; className?: string; children?: any }) { return <a href={to} className={className} onClick={(event: MouseEvent) => { event.preventDefault(); window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); }}>{children}</a>; }
function useNavigate() { return (to: string) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); }
function useParams(): { id?: string } { const match = window.location.pathname.match(/\/mobile-download\/([^/]+)/); return { id: match?.[1] }; }

const defaultOptions: ProcessingOptions = {
  mode: 'basic',
  smoothEdges: true,
  autoTrim: true,
  keepOriginalSize: true,
};

const stageLabels: Record<ProcessingStage, string> = {
  idle: '대기 중',
  uploading: '업로드 중',
  analyzing: 'AI 분석 중',
  removing: '배경 제거 중',
  generating: '결과 생성 중',
  done: '완료',
};

function formatSize(size: number) {
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function saveRecord(record: ResultRecord) {
  sessionStorage.setItem('make-real-png:last-result', JSON.stringify(record));
  sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record));
}

function readRecord(id?: string): ResultRecord | null {
  const key = id ? `make-real-png:result:${id}` : 'make-real-png:last-result';
  const raw = sessionStorage.getItem(key);
  return raw ? (JSON.parse(raw) as ResultRecord) : null;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [path, setPath] = React.useState(window.location.pathname);
  React.useMemo(() => {
    const onNavigate = (event: Event) => {
      const to = (event as CustomEvent<string>).detail;
      window.history.pushState({}, '', to);
      setPath(window.location.pathname);
    };
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('app:navigate', onNavigate);
    window.addEventListener('popstate', onPop);
    return () => { window.removeEventListener('app:navigate', onNavigate); window.removeEventListener('popstate', onPop); };
  }, []);
  if (path.startsWith('/mobile-download/')) return <MobileDownloadPage />;
  if (path === '/result') return <ResultPage />;
  return <LandingPage />;
}

function LandingPage() {
  const navigate = useNavigate();
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = React.useState('');
  const [options, setOptions] = React.useState(defaultOptions);
  const [stage, setStage] = React.useState<ProcessingStage>('idle');
  const [error, setError] = React.useState<AppError | null>(null);

  const handleFile = (file?: File) => {
    if (!file) return;
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploadedFile(file);
    setOriginalUrl(URL.createObjectURL(file));
  };

  const startProcess = async () => {
    if (!uploadedFile) return;
    try {
      const resultUrl = await removeBackground(uploadedFile, options, setStage);
      const id = crypto.randomUUID();
      saveRecord({ id, originalUrl, resultUrl, fileName: uploadedFile.name, options, createdAt: Date.now() });
      navigate('/result');
    } catch {
      setError({ type: 'ai-failed', message: ERROR_MESSAGES['ai-failed'] });
      setStage('idle');
    }
  };

  const reset = () => {
    const next = resetFlow();
    setUploadedFile(next.uploadedFile);
    setOriginalUrl(next.originalUrl);
    setError(next.error);
    setStage(next.stage);
  };

  if (stage !== 'idle' && stage !== 'done') {
    return <ProcessingScreen stage={stage} />;
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
        <div className="flex flex-col justify-center">
          <span className="w-fit rounded-full bg-blue-100 px-4 py-2 text-sm font-semibold text-blue-700">QR 모바일 저장 특화 MVP</span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight md:text-6xl">AI 배경 제거 후, 모바일 저장까지 한 번에</h1>
          <p className="mt-5 text-lg leading-8 text-slate-600">이미지를 업로드하면 mock AI 흐름으로 배경 제거 결과를 만들고 PNG/WebP/JPG 다운로드와 QR코드 모바일 저장 링크를 제공합니다.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#upload" className="rounded-2xl bg-blue-600 px-6 py-4 font-bold text-white shadow-lg shadow-blue-200">이미지 업로드하기</a>
            <button onClick={() => createSample(handleFile)} className="rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800">샘플 이미지로 체험하기</button>
          </div>
          <div className="mt-8 grid gap-3 text-sm text-slate-500 sm:grid-cols-3">
            <Info label="지원 형식" value="JPG, PNG, WebP" />
            <Info label="최대 용량" value="10MB" />
            <Info label="다중 업로드" value="UI 준비 / MVP 단일 처리" />
          </div>
        </div>
        <div id="upload" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/70">
          <UploadBox onFile={handleFile} />
          {error && <ErrorState error={error} onRetry={() => setError(null)} onNew={reset} />}
          {uploadedFile && <FilePreviewCard file={uploadedFile} imageUrl={originalUrl} />}
          <ProcessingOptionsPanel options={options} onChange={setOptions} />
          <button disabled={!uploadedFile} onClick={startProcess} className="mt-5 w-full rounded-2xl bg-slate-950 px-6 py-4 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">배경 제거 시작</button>
        </div>
      </section>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="font-bold text-slate-900">{label}</p><p>{value}</p></div>;
}

function UploadBox({ onFile }: { onFile: (file?: File) => void }) {
  return (
    <label onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }} className="flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-300 bg-blue-50/60 p-10 text-center">
      <span className="text-5xl">🖼️</span>
      <strong className="mt-4 text-xl">이미지를 드래그 앤 드롭하세요</strong>
      <span className="mt-2 text-slate-500">또는 파일 선택 업로드 버튼을 눌러주세요.</span>
      <span className="mt-5 rounded-xl bg-blue-600 px-5 py-3 font-bold text-white">파일 선택 업로드</span>
      <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => onFile(e.target.files?.[0])} />
    </label>
  );
}

function FilePreviewCard({ file, imageUrl }: { file: File; imageUrl: string }) {
  return <div className="mt-5 flex gap-4 rounded-2xl border border-slate-200 p-4"><img src={imageUrl} className="h-24 w-24 rounded-xl object-cover" /><div><p className="font-bold">{file.name}</p><p className="text-sm text-slate-500">{formatSize(file.size)} · 검증 완료</p><p className="mt-2 text-sm text-emerald-600">미리보기 카드가 생성되었습니다.</p></div></div>;
}

function ProcessingOptionsPanel({ options, onChange }: { options: ProcessingOptions; onChange: (options: ProcessingOptions) => void }) {
  const modes = [{ id: 'basic', label: '기본 배경 제거' }, { id: 'person', label: '인물 우선 모드' }, { id: 'product', label: '제품/사물 우선 모드' }] as const;
  const toggles = [{ key: 'smoothEdges', label: '가장자리 부드럽게' }, { key: 'autoTrim', label: '여백 자동 정리' }, { key: 'keepOriginalSize', label: '원본 크기 유지' }] as const;
  return <section className="mt-5 rounded-2xl bg-slate-50 p-4"><h2 className="font-bold">처리 옵션</h2><div className="mt-3 grid gap-2">{modes.map((mode) => <button key={mode.id} onClick={() => onChange({ ...options, mode: mode.id })} className={`rounded-xl border p-3 text-left ${options.mode === mode.id ? 'border-blue-500 bg-blue-50 font-bold text-blue-700' : 'border-slate-200 bg-white'}`}>{mode.label}</button>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-3">{toggles.map((toggle) => <label key={toggle.key} className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm"><input type="checkbox" checked={options[toggle.key]} onChange={(e) => onChange({ ...options, [toggle.key]: e.target.checked })} />{toggle.label}</label>)}</div></section>;
}

function ProcessingScreen({ stage }: { stage: ProcessingStage }) {
  const steps: ProcessingStage[] = ['uploading', 'analyzing', 'removing', 'generating'];
  const current = steps.indexOf(stage);
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-5 text-white"><div className="w-full max-w-xl rounded-3xl bg-white/10 p-8"><div className="mx-auto h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-blue-400" /><h1 className="mt-6 text-center text-3xl font-extrabold">{stageLabels[stage]}</h1><div className="mt-8 space-y-3">{steps.map((step, index) => <div key={step} className={`rounded-2xl p-4 ${index <= current ? 'bg-blue-500' : 'bg-white/10'}`}>{stageLabels[step]}</div>)}</div></div></main>;
}

function ResultPage() {
  const navigate = useNavigate();
  const record = readRecord();
  const [background, setBackground] = React.useState<BackgroundMode>('transparent');
  const [zoom, setZoom] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [complete, setComplete] = React.useState(false);

  if (!record) return <MissingResult />;

  return <main className="min-h-screen bg-slate-50 px-5 py-8"><div className="mx-auto max-w-7xl"><header className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="font-bold text-blue-600">배경 제거 완료</p><h1 className="text-3xl font-extrabold">결과 확인 및 다운로드</h1></div><button onClick={() => navigate('/')} className="rounded-2xl bg-white px-5 py-3 font-bold shadow">새 이미지 업로드</button></header><div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]"><section className="space-y-6"><CompareSlider originalUrl={record.originalUrl} resultUrl={record.resultUrl} background={background} zoom={zoom} /><BackgroundPreviewToggle value={background} onChange={setBackground} zoom={zoom} onZoom={setZoom} /><EditToolbar onAction={(label) => setNotice(`${label}: 준비 중인 기능입니다.`)} />{notice && <p className="rounded-2xl bg-amber-50 p-4 font-semibold text-amber-700">{notice}</p>}<div className="flex flex-wrap gap-3"><button onClick={() => navigate('/')} className="rounded-2xl border bg-white px-5 py-3 font-bold">다시 처리하기</button><button onClick={() => navigate('/')} className="rounded-2xl border bg-white px-5 py-3 font-bold">새 이미지 업로드</button></div></section><aside className="space-y-6"><DownloadPanel record={record} onComplete={() => setComplete(true)} /><QRDownloadPanel record={record} /><CompletionPanel show={complete} onResult={() => setComplete(false)} /></aside></div></div></main>;
}

function CompareSlider({ originalUrl, resultUrl, background, zoom }: { originalUrl: string; resultUrl: string; background: BackgroundMode; zoom: boolean }) {
  const [split, setSplit] = React.useState(50);
  const bgClass = background === 'transparent' ? 'checker' : background === 'white' ? 'bg-white' : 'bg-slate-950';
  return <div className={`relative overflow-hidden rounded-3xl border border-slate-200 ${bgClass}`}><img src={resultUrl} className={`mx-auto h-[460px] w-full object-contain ${zoom ? 'scale-125' : ''}`} /><div className="absolute inset-0 overflow-hidden" style={{ width: `${split}%` }}><img src={originalUrl} className={`h-[460px] w-full max-w-none object-contain ${zoom ? 'scale-125' : ''}`} /></div><input aria-label="원본 결과 비교 슬라이더" type="range" min="0" max="100" value={split} onChange={(e) => setSplit(Number(e.target.value))} className="absolute bottom-5 left-1/2 w-3/4 -translate-x-1/2" /><span className="absolute left-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold">원본</span><span className="absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold">결과</span></div>;
}

function BackgroundPreviewToggle({ value, onChange, zoom, onZoom }: { value: BackgroundMode; onChange: (value: BackgroundMode) => void; zoom: boolean; onZoom: (value: boolean) => void }) {
  return <div className="rounded-3xl bg-white p-4 shadow"><h2 className="font-bold">배경 미리보기</h2><div className="mt-3 flex flex-wrap gap-2">{(['transparent', 'white', 'black'] as BackgroundMode[]).map((mode) => <button key={mode} onClick={() => onChange(mode)} className={`rounded-xl px-4 py-2 font-bold ${value === mode ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>{mode === 'transparent' ? '투명 체크무늬' : mode === 'white' ? '흰 배경' : '검은 배경'}</button>)}<button onClick={() => onZoom(!zoom)} className="rounded-xl bg-slate-900 px-4 py-2 font-bold text-white">확대해서 가장자리 확인</button></div></div>;
}

function EditToolbar({ onAction }: { onAction: (label: string) => void }) {
  return <div className="rounded-3xl bg-white p-4 shadow"><h2 className="font-bold">간단 편집 UI</h2><div className="mt-3 grid gap-2 sm:grid-cols-3">{['배경 제거 강도 조정', '지우개', '복원 브러시', '이미지 자르기', '여백 추가/제거', '파일명 수정'].map((label) => <button key={label} onClick={() => onAction(label)} className="rounded-xl border border-slate-200 px-4 py-3 font-semibold hover:bg-slate-50">{label}</button>)}</div></div>;
}

function DownloadPanel({ record, onComplete }: { record: ResultRecord; onComplete: () => void }) {
  const baseName = record.fileName.replace(/\.[^/.]+$/, '') || 'result';
  const handleDownload = async (format: DownloadFormat) => {
    const blob = await generateDownloadBlob(record.resultUrl, format);
    downloadBlob(blob, `${baseName}-background-removed.${format}`);
    onComplete();
  };
  return <section className="rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-extrabold">다운로드</h2><div className="mt-4 grid gap-3"> <button onClick={() => handleDownload('png')} className="rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white">PNG 투명 배경 다운로드</button><button onClick={() => handleDownload('webp')} className="rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white">WebP 다운로드</button><button onClick={() => handleDownload('jpg')} className="rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200">JPG 흰 배경 다운로드</button><button disabled className="cursor-not-allowed rounded-2xl bg-slate-100 px-5 py-3 font-bold text-slate-500" title="다중 업로드 시 사용 가능합니다.">ZIP 다운로드 · 다중 업로드 시 사용 가능</button></div></section>;
}

function QRDownloadPanel({ record }: { record: ResultRecord }) {
  const [qr, setQr] = React.useState('');
  const mobileUrl = React.useMemo(() => `${window.location.origin}/mobile-download/${record.id}`, [record.id]);
  const createQr = async () => setQr(await generateQRCode(mobileUrl));
  return <section className="rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-extrabold">QR 모바일 저장</h2><p className="mt-2 text-sm text-slate-500">모바일에서 QR코드를 스캔하면 결과 이미지를 저장할 수 있습니다.</p><p className="text-sm text-slate-500">링크는 24시간 후 만료됩니다.</p><button onClick={createQr} className="mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white">QR코드 생성</button>{qr && <div className="mt-4 rounded-2xl border p-4 text-center"><img src={qr} className="mx-auto" /><p className="mt-3 break-all text-xs text-slate-500">{mobileUrl}</p></div>}</section>;
}

function CompletionPanel({ show, onResult }: { show: boolean; onResult: () => void }) {
  const navigate = useNavigate();
  if (!show) return null;
  return <section className="rounded-3xl bg-blue-50 p-5"><h2 className="text-xl font-extrabold text-blue-900">완료되었습니다</h2><div className="mt-4 grid gap-2"><button onClick={() => navigate('/')} className="rounded-xl bg-blue-600 px-4 py-3 font-bold text-white">다른 이미지 업로드</button><button onClick={() => navigate('/')} className="rounded-xl bg-white px-4 py-3 font-bold">같은 옵션으로 새 이미지 처리</button><button onClick={onResult} className="rounded-xl bg-white px-4 py-3 font-bold">결과 다시 보기</button><button onClick={() => navigator.share?.({ title: 'Make Real PNG', url: location.href })} className="rounded-xl bg-white px-4 py-3 font-bold">서비스 공유하기</button><button className="rounded-xl bg-slate-950 px-4 py-3 font-bold text-white">회원가입/로그인하고 결과 보관</button></div></section>;
}

function ErrorState({ error, onRetry, onNew }: { error: AppError; onRetry: () => void; onNew: () => void }) {
  return <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4"><p className="font-bold text-red-700">{error.message}</p><div className="mt-3 flex gap-2"><button onClick={onRetry} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white">다시 시도</button><button onClick={onNew} className="rounded-xl bg-white px-4 py-2 font-bold text-red-700">새 이미지 업로드</button></div></div>;
}

function MobileDownloadPage() {
  const { id } = useParams();
  const record = readRecord(id);
  if (!record) return <MissingResult />;
  return <main className="min-h-screen bg-slate-950 p-5 text-white"><section className="mx-auto max-w-md rounded-3xl bg-white p-5 text-slate-950"><p className="font-bold text-emerald-600">모바일 다운로드 페이지</p><h1 className="mt-2 text-2xl font-extrabold">결과 이미지를 길게 눌러 저장하세요</h1><img src={record.resultUrl} className="checker mt-5 w-full rounded-2xl object-contain" /><p className="mt-4 text-sm text-slate-500">iOS/Android 브라우저에서 이미지를 길게 누른 뒤 “사진에 저장” 또는 “이미지 다운로드”를 선택하세요.</p><Link to="/" className="mt-5 block rounded-2xl bg-blue-600 px-5 py-3 text-center font-bold text-white">다른 이미지 업로드</Link></section></main>;
}

function MissingResult() {
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5"><div className="max-w-md rounded-3xl bg-white p-8 text-center shadow"><h1 className="text-2xl font-extrabold">결과를 찾을 수 없습니다</h1><p className="mt-3 text-slate-500">브라우저 메모리 기반 MVP라 새로고침 또는 24시간 만료 후에는 다시 업로드가 필요합니다.</p><Link to="/" className="mt-6 inline-block rounded-2xl bg-blue-600 px-6 py-3 font-bold text-white">새 이미지 업로드</Link></div></main>;
}

function createSample(onFile: (file: File) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#dbeafe';
  ctx.fillRect(0, 0, 900, 600);
  ctx.fillStyle = '#2563eb';
  ctx.beginPath();
  ctx.arc(450, 260, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(310, 390, 280, 70);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('SAMPLE', 380, 435);
  canvas.toBlob((blob) => blob && onFile(new File([blob], 'sample-product.png', { type: 'image/png' })), 'image/png');
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
