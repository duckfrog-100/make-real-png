"use strict";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ERROR_MESSAGES = {
    'file-size': '파일 용량이 너무 큽니다. 10MB 이하 이미지로 다시 업로드해주세요.',
    'file-type': 'JPG, PNG, WebP 형식만 업로드할 수 있습니다.',
    'ai-failed': '배경 제거에 실패했습니다. 이미지를 다시 업로드하거나 잠시 후 재시도해주세요.',
    network: '연결이 불안정합니다. 인터넷 상태를 확인한 뒤 다시 시도해주세요.',
};
function validateFile(file) {
    if (!ACCEPTED_TYPES.includes(file.type))
        return { type: 'file-type', message: ERROR_MESSAGES['file-type'] };
    if (file.size > MAX_FILE_SIZE)
        return { type: 'file-size', message: ERROR_MESSAGES['file-size'] };
    return null;
}
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
async function removeBackground(file, options, onStageChange) {
    const steps = [
        { stage: 'uploading', delay: 700 }, { stage: 'analyzing', delay: 900 }, { stage: 'removing', delay: 1100 }, { stage: 'generating', delay: 800 },
    ];
    for (const step of steps) {
        onStageChange?.(step.stage);
        await wait(step.delay);
    }
    // TODO: 실제 서비스에서는 이 지점에서 AI 배경 제거 API를 호출하고 서버 저장 URL을 반환합니다.
    void options;
    onStageChange?.('done');
    return URL.createObjectURL(file);
}
function loadImage(imageUrl) { return new Promise((resolve, reject) => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.')); image.src = imageUrl; }); }
async function generateDownloadBlob(imageUrl, format) { const image = await loadImage(imageUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const context = canvas.getContext('2d'); if (!context)
    throw new Error('Canvas를 생성할 수 없습니다.'); if (format === 'jpg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
} context.drawImage(image, 0, 0); const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`; return new Promise((resolve, reject) => { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('다운로드 파일 생성에 실패했습니다.')), mimeType, 0.95); }); }
async function generateQRCode(downloadUrl) {
    // TODO: 운영 환경에서는 서버 저장 URL을 표준 QR 라이브러리 또는 백엔드에서 생성한 QR 이미지로 교체합니다.
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(downloadUrl)}`;
}
function resetFlow() { return { uploadedFile: null, originalUrl: '', resultUrl: '', error: null, stage: 'idle', qrLink: '' }; }
function Link({ to, className, children }) { return React.createElement("a", { href: to, className: className, onClick: (event) => { event.preventDefault(); window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); } }, children); }
function useNavigate() { return (to) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); }
function useParams() { const match = window.location.pathname.match(/\/mobile-download\/([^/]+)/); return { id: match?.[1] }; }
const defaultOptions = {
    mode: 'basic',
    smoothEdges: true,
    autoTrim: true,
    keepOriginalSize: true,
};
const stageLabels = {
    idle: '대기 중',
    uploading: '업로드 중',
    analyzing: 'AI 분석 중',
    removing: '배경 제거 중',
    generating: '결과 생성 중',
    done: '완료',
};
function formatSize(size) {
    return `${(size / 1024 / 1024).toFixed(2)}MB`;
}
function saveRecord(record) {
    sessionStorage.setItem('make-real-png:last-result', JSON.stringify(record));
    sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record));
}
function readRecord(id) {
    const key = id ? `make-real-png:result:${id}` : 'make-real-png:last-result';
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}
function downloadBlob(blob, fileName) {
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
        const onNavigate = (event) => {
            const to = event.detail;
            window.history.pushState({}, '', to);
            setPath(window.location.pathname);
        };
        const onPop = () => setPath(window.location.pathname);
        window.addEventListener('app:navigate', onNavigate);
        window.addEventListener('popstate', onPop);
        return () => { window.removeEventListener('app:navigate', onNavigate); window.removeEventListener('popstate', onPop); };
    }, []);
    if (path.startsWith('/mobile-download/'))
        return React.createElement(MobileDownloadPage, null);
    if (path === '/result')
        return React.createElement(ResultPage, null);
    return React.createElement(LandingPage, null);
}
function LandingPage() {
    const navigate = useNavigate();
    const [uploadedFile, setUploadedFile] = React.useState(null);
    const [originalUrl, setOriginalUrl] = React.useState('');
    const [options, setOptions] = React.useState(defaultOptions);
    const [stage, setStage] = React.useState('idle');
    const [error, setError] = React.useState(null);
    const handleFile = (file) => {
        if (!file)
            return;
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
        if (!uploadedFile)
            return;
        try {
            const resultUrl = await removeBackground(uploadedFile, options, setStage);
            const id = crypto.randomUUID();
            saveRecord({ id, originalUrl, resultUrl, fileName: uploadedFile.name, options, createdAt: Date.now() });
            navigate('/result');
        }
        catch {
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
        return React.createElement(ProcessingScreen, { stage: stage });
    }
    return (React.createElement("main", { className: "min-h-screen bg-slate-50 text-slate-950" },
        React.createElement("section", { className: "mx-auto grid max-w-7xl gap-10 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16" },
            React.createElement("div", { className: "flex flex-col justify-center" },
                React.createElement("span", { className: "w-fit rounded-full bg-blue-100 px-4 py-2 text-sm font-semibold text-blue-700" }, "QR \uBAA8\uBC14\uC77C \uC800\uC7A5 \uD2B9\uD654 MVP"),
                React.createElement("h1", { className: "mt-6 text-4xl font-extrabold tracking-tight md:text-6xl" }, "AI \uBC30\uACBD \uC81C\uAC70 \uD6C4, \uBAA8\uBC14\uC77C \uC800\uC7A5\uAE4C\uC9C0 \uD55C \uBC88\uC5D0"),
                React.createElement("p", { className: "mt-5 text-lg leading-8 text-slate-600" }, "\uC774\uBBF8\uC9C0\uB97C \uC5C5\uB85C\uB4DC\uD558\uBA74 mock AI \uD750\uB984\uC73C\uB85C \uBC30\uACBD \uC81C\uAC70 \uACB0\uACFC\uB97C \uB9CC\uB4E4\uACE0 PNG/WebP/JPG \uB2E4\uC6B4\uB85C\uB4DC\uC640 QR\uCF54\uB4DC \uBAA8\uBC14\uC77C \uC800\uC7A5 \uB9C1\uD06C\uB97C \uC81C\uACF5\uD569\uB2C8\uB2E4."),
                React.createElement("div", { className: "mt-8 flex flex-wrap gap-3" },
                    React.createElement("a", { href: "#upload", className: "rounded-2xl bg-blue-600 px-6 py-4 font-bold text-white shadow-lg shadow-blue-200" }, "\uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC\uD558\uAE30"),
                    React.createElement("button", { onClick: () => createSample(handleFile), className: "rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800" }, "\uC0D8\uD50C \uC774\uBBF8\uC9C0\uB85C \uCCB4\uD5D8\uD558\uAE30")),
                React.createElement("div", { className: "mt-8 grid gap-3 text-sm text-slate-500 sm:grid-cols-3" },
                    React.createElement(Info, { label: "\uC9C0\uC6D0 \uD615\uC2DD", value: "JPG, PNG, WebP" }),
                    React.createElement(Info, { label: "\uCD5C\uB300 \uC6A9\uB7C9", value: "10MB" }),
                    React.createElement(Info, { label: "\uB2E4\uC911 \uC5C5\uB85C\uB4DC", value: "UI \uC900\uBE44 / MVP \uB2E8\uC77C \uCC98\uB9AC" }))),
            React.createElement("div", { id: "upload", className: "rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/70" },
                React.createElement(UploadBox, { onFile: handleFile }),
                error && React.createElement(ErrorState, { error: error, onRetry: () => setError(null), onNew: reset }),
                uploadedFile && React.createElement(FilePreviewCard, { file: uploadedFile, imageUrl: originalUrl }),
                React.createElement(ProcessingOptionsPanel, { options: options, onChange: setOptions }),
                React.createElement("button", { disabled: !uploadedFile, onClick: startProcess, className: "mt-5 w-full rounded-2xl bg-slate-950 px-6 py-4 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300" }, "\uBC30\uACBD \uC81C\uAC70 \uC2DC\uC791")))));
}
function Info({ label, value }) {
    return React.createElement("div", { className: "rounded-2xl border border-slate-200 bg-white p-4" },
        React.createElement("p", { className: "font-bold text-slate-900" }, label),
        React.createElement("p", null, value));
}
function UploadBox({ onFile }) {
    return (React.createElement("label", { onDragOver: (e) => e.preventDefault(), onDrop: (e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }, className: "flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-300 bg-blue-50/60 p-10 text-center" },
        React.createElement("span", { className: "text-5xl" }, "\uD83D\uDDBC\uFE0F"),
        React.createElement("strong", { className: "mt-4 text-xl" }, "\uC774\uBBF8\uC9C0\uB97C \uB4DC\uB798\uADF8 \uC564 \uB4DC\uB86D\uD558\uC138\uC694"),
        React.createElement("span", { className: "mt-2 text-slate-500" }, "\uB610\uB294 \uD30C\uC77C \uC120\uD0DD \uC5C5\uB85C\uB4DC \uBC84\uD2BC\uC744 \uB20C\uB7EC\uC8FC\uC138\uC694."),
        React.createElement("span", { className: "mt-5 rounded-xl bg-blue-600 px-5 py-3 font-bold text-white" }, "\uD30C\uC77C \uC120\uD0DD \uC5C5\uB85C\uB4DC"),
        React.createElement("input", { className: "sr-only", type: "file", accept: "image/jpeg,image/png,image/webp", onChange: (e) => onFile(e.target.files?.[0]) })));
}
function FilePreviewCard({ file, imageUrl }) {
    return React.createElement("div", { className: "mt-5 flex gap-4 rounded-2xl border border-slate-200 p-4" },
        React.createElement("img", { src: imageUrl, className: "h-24 w-24 rounded-xl object-cover" }),
        React.createElement("div", null,
            React.createElement("p", { className: "font-bold" }, file.name),
            React.createElement("p", { className: "text-sm text-slate-500" },
                formatSize(file.size),
                " \u00B7 \uAC80\uC99D \uC644\uB8CC"),
            React.createElement("p", { className: "mt-2 text-sm text-emerald-600" }, "\uBBF8\uB9AC\uBCF4\uAE30 \uCE74\uB4DC\uAC00 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4.")));
}
function ProcessingOptionsPanel({ options, onChange }) {
    const modes = [{ id: 'basic', label: '기본 배경 제거' }, { id: 'person', label: '인물 우선 모드' }, { id: 'product', label: '제품/사물 우선 모드' }];
    const toggles = [{ key: 'smoothEdges', label: '가장자리 부드럽게' }, { key: 'autoTrim', label: '여백 자동 정리' }, { key: 'keepOriginalSize', label: '원본 크기 유지' }];
    return React.createElement("section", { className: "mt-5 rounded-2xl bg-slate-50 p-4" },
        React.createElement("h2", { className: "font-bold" }, "\uCC98\uB9AC \uC635\uC158"),
        React.createElement("div", { className: "mt-3 grid gap-2" }, modes.map((mode) => React.createElement("button", { key: mode.id, onClick: () => onChange({ ...options, mode: mode.id }), className: `rounded-xl border p-3 text-left ${options.mode === mode.id ? 'border-blue-500 bg-blue-50 font-bold text-blue-700' : 'border-slate-200 bg-white'}` }, mode.label))),
        React.createElement("div", { className: "mt-4 grid gap-2 sm:grid-cols-3" }, toggles.map((toggle) => React.createElement("label", { key: toggle.key, className: "flex items-center gap-2 rounded-xl bg-white p-3 text-sm" },
            React.createElement("input", { type: "checkbox", checked: options[toggle.key], onChange: (e) => onChange({ ...options, [toggle.key]: e.target.checked }) }),
            toggle.label))));
}
function ProcessingScreen({ stage }) {
    const steps = ['uploading', 'analyzing', 'removing', 'generating'];
    const current = steps.indexOf(stage);
    return React.createElement("main", { className: "flex min-h-screen items-center justify-center bg-slate-950 p-5 text-white" },
        React.createElement("div", { className: "w-full max-w-xl rounded-3xl bg-white/10 p-8" },
            React.createElement("div", { className: "mx-auto h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-blue-400" }),
            React.createElement("h1", { className: "mt-6 text-center text-3xl font-extrabold" }, stageLabels[stage]),
            React.createElement("div", { className: "mt-8 space-y-3" }, steps.map((step, index) => React.createElement("div", { key: step, className: `rounded-2xl p-4 ${index <= current ? 'bg-blue-500' : 'bg-white/10'}` }, stageLabels[step])))));
}
function ResultPage() {
    const navigate = useNavigate();
    const record = readRecord();
    const [background, setBackground] = React.useState('transparent');
    const [zoom, setZoom] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const [complete, setComplete] = React.useState(false);
    if (!record)
        return React.createElement(MissingResult, null);
    return React.createElement("main", { className: "min-h-screen bg-slate-50 px-5 py-8" },
        React.createElement("div", { className: "mx-auto max-w-7xl" },
            React.createElement("header", { className: "flex flex-col justify-between gap-4 md:flex-row md:items-center" },
                React.createElement("div", null,
                    React.createElement("p", { className: "font-bold text-blue-600" }, "\uBC30\uACBD \uC81C\uAC70 \uC644\uB8CC"),
                    React.createElement("h1", { className: "text-3xl font-extrabold" }, "\uACB0\uACFC \uD655\uC778 \uBC0F \uB2E4\uC6B4\uB85C\uB4DC")),
                React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl bg-white px-5 py-3 font-bold shadow" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC")),
            React.createElement("div", { className: "mt-6 grid gap-6 lg:grid-cols-[1fr_380px]" },
                React.createElement("section", { className: "space-y-6" },
                    React.createElement(CompareSlider, { originalUrl: record.originalUrl, resultUrl: record.resultUrl, background: background, zoom: zoom }),
                    React.createElement(BackgroundPreviewToggle, { value: background, onChange: setBackground, zoom: zoom, onZoom: setZoom }),
                    React.createElement(EditToolbar, { onAction: (label) => setNotice(`${label}: 준비 중인 기능입니다.`) }),
                    notice && React.createElement("p", { className: "rounded-2xl bg-amber-50 p-4 font-semibold text-amber-700" }, notice),
                    React.createElement("div", { className: "flex flex-wrap gap-3" },
                        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl border bg-white px-5 py-3 font-bold" }, "\uB2E4\uC2DC \uCC98\uB9AC\uD558\uAE30"),
                        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl border bg-white px-5 py-3 font-bold" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))),
                React.createElement("aside", { className: "space-y-6" },
                    React.createElement(DownloadPanel, { record: record, onComplete: () => setComplete(true) }),
                    React.createElement(QRDownloadPanel, { record: record }),
                    React.createElement(CompletionPanel, { show: complete, onResult: () => setComplete(false) })))));
}
function CompareSlider({ originalUrl, resultUrl, background, zoom }) {
    const [split, setSplit] = React.useState(50);
    const bgClass = background === 'transparent' ? 'checker' : background === 'white' ? 'bg-white' : 'bg-slate-950';
    return React.createElement("div", { className: `relative overflow-hidden rounded-3xl border border-slate-200 ${bgClass}` },
        React.createElement("img", { src: resultUrl, className: `mx-auto h-[460px] w-full object-contain ${zoom ? 'scale-125' : ''}` }),
        React.createElement("div", { className: "absolute inset-0 overflow-hidden", style: { width: `${split}%` } },
            React.createElement("img", { src: originalUrl, className: `h-[460px] w-full max-w-none object-contain ${zoom ? 'scale-125' : ''}` })),
        React.createElement("input", { "aria-label": "\uC6D0\uBCF8 \uACB0\uACFC \uBE44\uAD50 \uC2AC\uB77C\uC774\uB354", type: "range", min: "0", max: "100", value: split, onChange: (e) => setSplit(Number(e.target.value)), className: "absolute bottom-5 left-1/2 w-3/4 -translate-x-1/2" }),
        React.createElement("span", { className: "absolute left-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold" }, "\uC6D0\uBCF8"),
        React.createElement("span", { className: "absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold" }, "\uACB0\uACFC"));
}
function BackgroundPreviewToggle({ value, onChange, zoom, onZoom }) {
    return React.createElement("div", { className: "rounded-3xl bg-white p-4 shadow" },
        React.createElement("h2", { className: "font-bold" }, "\uBC30\uACBD \uBBF8\uB9AC\uBCF4\uAE30"),
        React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
            ['transparent', 'white', 'black'].map((mode) => React.createElement("button", { key: mode, onClick: () => onChange(mode), className: `rounded-xl px-4 py-2 font-bold ${value === mode ? 'bg-blue-600 text-white' : 'bg-slate-100'}` }, mode === 'transparent' ? '투명 체크무늬' : mode === 'white' ? '흰 배경' : '검은 배경')),
            React.createElement("button", { onClick: () => onZoom(!zoom), className: "rounded-xl bg-slate-900 px-4 py-2 font-bold text-white" }, "\uD655\uB300\uD574\uC11C \uAC00\uC7A5\uC790\uB9AC \uD655\uC778")));
}
function EditToolbar({ onAction }) {
    return React.createElement("div", { className: "rounded-3xl bg-white p-4 shadow" },
        React.createElement("h2", { className: "font-bold" }, "\uAC04\uB2E8 \uD3B8\uC9D1 UI"),
        React.createElement("div", { className: "mt-3 grid gap-2 sm:grid-cols-3" }, ['배경 제거 강도 조정', '지우개', '복원 브러시', '이미지 자르기', '여백 추가/제거', '파일명 수정'].map((label) => React.createElement("button", { key: label, onClick: () => onAction(label), className: "rounded-xl border border-slate-200 px-4 py-3 font-semibold hover:bg-slate-50" }, label))));
}
function DownloadPanel({ record, onComplete }) {
    const baseName = record.fileName.replace(/\.[^/.]+$/, '') || 'result';
    const handleDownload = async (format) => {
        const blob = await generateDownloadBlob(record.resultUrl, format);
        downloadBlob(blob, `${baseName}-background-removed.${format}`);
        onComplete();
    };
    return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
        React.createElement("h2", { className: "text-xl font-extrabold" }, "\uB2E4\uC6B4\uB85C\uB4DC"),
        React.createElement("div", { className: "mt-4 grid gap-3" },
            " ",
            React.createElement("button", { onClick: () => handleDownload('png'), className: "rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white" }, "PNG \uD22C\uBA85 \uBC30\uACBD \uB2E4\uC6B4\uB85C\uB4DC"),
            React.createElement("button", { onClick: () => handleDownload('webp'), className: "rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white" }, "WebP \uB2E4\uC6B4\uB85C\uB4DC"),
            React.createElement("button", { onClick: () => handleDownload('jpg'), className: "rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200" }, "JPG \uD770 \uBC30\uACBD \uB2E4\uC6B4\uB85C\uB4DC"),
            React.createElement("button", { disabled: true, className: "cursor-not-allowed rounded-2xl bg-slate-100 px-5 py-3 font-bold text-slate-500", title: "\uB2E4\uC911 \uC5C5\uB85C\uB4DC \uC2DC \uC0AC\uC6A9 \uAC00\uB2A5\uD569\uB2C8\uB2E4." }, "ZIP \uB2E4\uC6B4\uB85C\uB4DC \u00B7 \uB2E4\uC911 \uC5C5\uB85C\uB4DC \uC2DC \uC0AC\uC6A9 \uAC00\uB2A5")));
}
function QRDownloadPanel({ record }) {
    const [qr, setQr] = React.useState('');
    const mobileUrl = React.useMemo(() => `${window.location.origin}/mobile-download/${record.id}`, [record.id]);
    const createQr = async () => setQr(await generateQRCode(mobileUrl));
    return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
        React.createElement("h2", { className: "text-xl font-extrabold" }, "QR \uBAA8\uBC14\uC77C \uC800\uC7A5"),
        React.createElement("p", { className: "mt-2 text-sm text-slate-500" }, "\uBAA8\uBC14\uC77C\uC5D0\uC11C QR\uCF54\uB4DC\uB97C \uC2A4\uCE94\uD558\uBA74 \uACB0\uACFC \uC774\uBBF8\uC9C0\uB97C \uC800\uC7A5\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."),
        React.createElement("p", { className: "text-sm text-slate-500" }, "\uB9C1\uD06C\uB294 24\uC2DC\uAC04 \uD6C4 \uB9CC\uB8CC\uB429\uB2C8\uB2E4."),
        React.createElement("button", { onClick: createQr, className: "mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white" }, "QR\uCF54\uB4DC \uC0DD\uC131"),
        qr && React.createElement("div", { className: "mt-4 rounded-2xl border p-4 text-center" },
            React.createElement("img", { src: qr, className: "mx-auto" }),
            React.createElement("p", { className: "mt-3 break-all text-xs text-slate-500" }, mobileUrl)));
}
function CompletionPanel({ show, onResult }) {
    const navigate = useNavigate();
    if (!show)
        return null;
    return React.createElement("section", { className: "rounded-3xl bg-blue-50 p-5" },
        React.createElement("h2", { className: "text-xl font-extrabold text-blue-900" }, "\uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4"),
        React.createElement("div", { className: "mt-4 grid gap-2" },
            React.createElement("button", { onClick: () => navigate('/'), className: "rounded-xl bg-blue-600 px-4 py-3 font-bold text-white" }, "\uB2E4\uB978 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"),
            React.createElement("button", { onClick: () => navigate('/'), className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uAC19\uC740 \uC635\uC158\uC73C\uB85C \uC0C8 \uC774\uBBF8\uC9C0 \uCC98\uB9AC"),
            React.createElement("button", { onClick: onResult, className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uACB0\uACFC \uB2E4\uC2DC \uBCF4\uAE30"),
            React.createElement("button", { onClick: () => navigator.share?.({ title: 'Make Real PNG', url: location.href }), className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uC11C\uBE44\uC2A4 \uACF5\uC720\uD558\uAE30"),
            React.createElement("button", { className: "rounded-xl bg-slate-950 px-4 py-3 font-bold text-white" }, "\uD68C\uC6D0\uAC00\uC785/\uB85C\uADF8\uC778\uD558\uACE0 \uACB0\uACFC \uBCF4\uAD00")));
}
function ErrorState({ error, onRetry, onNew }) {
    return React.createElement("div", { className: "mt-5 rounded-2xl border border-red-200 bg-red-50 p-4" },
        React.createElement("p", { className: "font-bold text-red-700" }, error.message),
        React.createElement("div", { className: "mt-3 flex gap-2" },
            React.createElement("button", { onClick: onRetry, className: "rounded-xl bg-red-600 px-4 py-2 font-bold text-white" }, "\uB2E4\uC2DC \uC2DC\uB3C4"),
            React.createElement("button", { onClick: onNew, className: "rounded-xl bg-white px-4 py-2 font-bold text-red-700" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC")));
}
function MobileDownloadPage() {
    const { id } = useParams();
    const record = readRecord(id);
    if (!record)
        return React.createElement(MissingResult, null);
    return React.createElement("main", { className: "min-h-screen bg-slate-950 p-5 text-white" },
        React.createElement("section", { className: "mx-auto max-w-md rounded-3xl bg-white p-5 text-slate-950" },
            React.createElement("p", { className: "font-bold text-emerald-600" }, "\uBAA8\uBC14\uC77C \uB2E4\uC6B4\uB85C\uB4DC \uD398\uC774\uC9C0"),
            React.createElement("h1", { className: "mt-2 text-2xl font-extrabold" }, "\uACB0\uACFC \uC774\uBBF8\uC9C0\uB97C \uAE38\uAC8C \uB20C\uB7EC \uC800\uC7A5\uD558\uC138\uC694"),
            React.createElement("img", { src: record.resultUrl, className: "checker mt-5 w-full rounded-2xl object-contain" }),
            React.createElement("p", { className: "mt-4 text-sm text-slate-500" }, "iOS/Android \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uC774\uBBF8\uC9C0\uB97C \uAE38\uAC8C \uB204\uB978 \uB4A4 \u201C\uC0AC\uC9C4\uC5D0 \uC800\uC7A5\u201D \uB610\uB294 \u201C\uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC\u201D\uB97C \uC120\uD0DD\uD558\uC138\uC694."),
            React.createElement(Link, { to: "/", className: "mt-5 block rounded-2xl bg-blue-600 px-5 py-3 text-center font-bold text-white" }, "\uB2E4\uB978 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC")));
}
function MissingResult() {
    return React.createElement("main", { className: "flex min-h-screen items-center justify-center bg-slate-50 p-5" },
        React.createElement("div", { className: "max-w-md rounded-3xl bg-white p-8 text-center shadow" },
            React.createElement("h1", { className: "text-2xl font-extrabold" }, "\uACB0\uACFC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4"),
            React.createElement("p", { className: "mt-3 text-slate-500" }, "\uBE0C\uB77C\uC6B0\uC800 \uBA54\uBAA8\uB9AC \uAE30\uBC18 MVP\uB77C \uC0C8\uB85C\uACE0\uCE68 \uB610\uB294 24\uC2DC\uAC04 \uB9CC\uB8CC \uD6C4\uC5D0\uB294 \uB2E4\uC2DC \uC5C5\uB85C\uB4DC\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4."),
            React.createElement(Link, { to: "/", className: "mt-6 inline-block rounded-2xl bg-blue-600 px-6 py-3 font-bold text-white" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC")));
}
function createSample(onFile) {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
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
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
    React.createElement(App, null)));
