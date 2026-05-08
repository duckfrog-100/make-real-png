"use strict";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ERROR_MESSAGES = {
    'file-size': '파일 용량이 너무 큽니다. 10MB 이하 이미지로 다시 업로드해주세요.',
    'file-type': 'JPG, PNG, WebP 형식만 업로드할 수 있습니다.',
    'ai-failed': '배경 제거에 실패했습니다. 이미지를 다시 업로드하거나 잠시 후 재시도해주세요.',
    network: '연결이 불안정합니다. 인터넷 상태를 확인한 뒤 다시 시도해주세요.',
};
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const BACKGROUND_SAMPLE_STRIDE = 6;
const BACKGROUND_COLOR_BUCKET = 16;
const CHECKER_LIGHT_THRESHOLD = 220;
const CHECKER_NEUTRAL_THRESHOLD = 22;
const defaultOptions = { mode: 'basic', smoothEdges: true, autoTrim: true, keepOriginalSize: true, strength: 36 };
const stageLabels = { idle: '대기 중', uploading: '업로드 중', analyzing: 'AI 분석 중', removing: '배경 제거 중', generating: '결과 생성 중', done: '완료' };
const toolLabels = { strength: '배경 제거 강도 조정', eraser: '지우개', restore: '복원 브러시', crop: '이미지 자르기', padding: '여백 추가/제거', filename: '파일명 수정' };
function validateFile(file) {
    if (!ACCEPTED_TYPES.includes(file.type))
        return { type: 'file-type', message: ERROR_MESSAGES['file-type'] };
    if (file.size > MAX_FILE_SIZE)
        return { type: 'file-size', message: ERROR_MESSAGES['file-size'] };
    return null;
}
async function removeBackground(file, options, onStageChange) {
    const steps = [
        { stage: 'uploading', delay: 300 }, { stage: 'analyzing', delay: 350 }, { stage: 'removing', delay: 350 }, { stage: 'generating', delay: 250 },
    ];
    let resultUrl = '';
    for (const step of steps) {
        onStageChange?.(step.stage);
        if (step.stage === 'removing')
            resultUrl = await removeBackgroundLocally(file, options);
        await wait(step.delay);
    }
    onStageChange?.('done');
    return resultUrl;
}
function loadImage(imageUrl) { return new Promise((resolve, reject) => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.')); image.src = imageUrl; }); }
async function loadFileImage(file) { const url = URL.createObjectURL(file); try {
    return await loadImage(url);
}
finally {
    URL.revokeObjectURL(url);
} }
function imageDataToBlob(canvas, type = 'image/png', quality) { return new Promise((resolve, reject) => { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('이미지 파일 생성에 실패했습니다.')), type, quality); }); }
async function canvasToObjectUrl(canvas, type = 'image/png', quality) { return URL.createObjectURL(await imageDataToBlob(canvas, type, quality)); }
async function removeBackgroundLocally(file, options) {
    const image = await loadFileImage(file);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = image.naturalWidth || image.width;
    sourceCanvas.height = image.naturalHeight || image.height;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext)
        throw new Error('Canvas를 생성할 수 없습니다.');
    sourceContext.drawImage(image, 0, 0);
    const imageData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const backgroundColors = detectBackgroundColors(imageData);
    const backgroundMask = createBackgroundMask(imageData, backgroundColors, options.strength);
    applyTransparency(imageData, backgroundMask, options.smoothEdges);
    const outputCanvas = options.autoTrim && !options.keepOriginalSize ? trimTransparentPixels(imageData) : sourceCanvas;
    const outputContext = outputCanvas.getContext('2d');
    if (!outputContext)
        throw new Error('Canvas를 생성할 수 없습니다.');
    if (outputCanvas === sourceCanvas)
        outputContext.putImageData(imageData, 0, 0);
    return canvasToObjectUrl(outputCanvas);
}
function detectBackgroundColors(imageData) {
    const { data, width, height } = imageData;
    const counts = new Map();
    const addSample = (x, y) => {
        const index = (y * width + x) * 4;
        const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
        const key = `${Math.round(color.r / BACKGROUND_COLOR_BUCKET)},${Math.round(color.g / BACKGROUND_COLOR_BUCKET)},${Math.round(color.b / BACKGROUND_COLOR_BUCKET)}`;
        const current = counts.get(key);
        counts.set(key, { color, count: (current?.count || 0) + 1 });
    };
    for (let x = 0; x < width; x += BACKGROUND_SAMPLE_STRIDE) {
        addSample(x, 0);
        addSample(x, height - 1);
    }
    for (let y = 0; y < height; y += BACKGROUND_SAMPLE_STRIDE) {
        addSample(0, y);
        addSample(width - 1, y);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(({ color }) => color);
}
function createBackgroundMask(imageData, backgroundColors, strength) {
    const { width, height } = imageData;
    const visited = new Uint8Array(width * height);
    const queue = [];
    const enqueue = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height)
            return;
        const pixel = y * width + x;
        if (visited[pixel] || !isBackgroundPixel(imageData, pixel, backgroundColors, strength))
            return;
        visited[pixel] = 1;
        queue.push(pixel);
    };
    for (let x = 0; x < width; x += 1) {
        enqueue(x, 0);
        enqueue(x, height - 1);
    }
    for (let y = 0; y < height; y += 1) {
        enqueue(0, y);
        enqueue(width - 1, y);
    }
    for (let index = 0; index < queue.length; index += 1) {
        const pixel = queue[index];
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        enqueue(x + 1, y);
        enqueue(x - 1, y);
        enqueue(x, y + 1);
        enqueue(x, y - 1);
    }
    return visited;
}
function isBackgroundPixel(imageData, pixel, backgroundColors, strength) {
    const index = pixel * 4;
    const data = imageData.data;
    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    const max = Math.max(color.r, color.g, color.b);
    const min = Math.min(color.r, color.g, color.b);
    const average = (color.r + color.g + color.b) / 3;
    if (average > CHECKER_LIGHT_THRESHOLD && max - min < CHECKER_NEUTRAL_THRESHOLD + strength / 8)
        return true;
    return backgroundColors.some((background) => colorDistance(color, background) < strength);
}
function colorDistance(a, b) { const r = a.r - b.r; const g = a.g - b.g; const bDiff = a.b - b.b; return Math.sqrt(r * r + g * g + bDiff * bDiff); }
function applyTransparency(imageData, backgroundMask, smoothEdges) {
    const { data, width, height } = imageData;
    for (let pixel = 0; pixel < backgroundMask.length; pixel += 1)
        if (backgroundMask[pixel])
            data[pixel * 4 + 3] = 0;
    if (!smoothEdges)
        return;
    const nextAlpha = new Uint8ClampedArray(width * height);
    for (let pixel = 0; pixel < nextAlpha.length; pixel += 1)
        nextAlpha[pixel] = data[pixel * 4 + 3];
    for (let y = 1; y < height - 1; y += 1)
        for (let x = 1; x < width - 1; x += 1) {
            const pixel = y * width + x;
            if (backgroundMask[pixel])
                continue;
            const touchesBackground = backgroundMask[pixel - 1] || backgroundMask[pixel + 1] || backgroundMask[pixel - width] || backgroundMask[pixel + width];
            if (touchesBackground)
                nextAlpha[pixel] = Math.min(nextAlpha[pixel], 225);
        }
    for (let pixel = 0; pixel < nextAlpha.length; pixel += 1)
        data[pixel * 4 + 3] = nextAlpha[pixel];
}
function trimTransparentPixels(imageData) {
    const { data, width, height } = imageData;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1)
            if (data[(y * width + x) * 4 + 3] !== 0) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
    if (maxX < minX || maxY < minY)
        return imageDataToCanvas(imageData);
    const output = document.createElement('canvas');
    output.width = maxX - minX + 1;
    output.height = maxY - minY + 1;
    output.getContext('2d')?.putImageData(imageData, -minX, -minY);
    return output;
}
function imageDataToCanvas(imageData) { const canvas = document.createElement('canvas'); canvas.width = imageData.width; canvas.height = imageData.height; canvas.getContext('2d')?.putImageData(imageData, 0, 0); return canvas; }
async function generateDownloadBlob(imageUrl, format) { const image = await loadImage(imageUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const context = canvas.getContext('2d'); if (!context)
    throw new Error('Canvas를 생성할 수 없습니다.'); if (format === 'jpg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
} context.drawImage(image, 0, 0); const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`; return imageDataToBlob(canvas, mimeType, 0.95); }
async function generateQRCode(downloadUrl) { return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(downloadUrl)}`; }
function formatSize(size) { return `${(size / 1024 / 1024).toFixed(2)}MB`; }
function saveRecords(records) {
    const last = records[0];
    sessionStorage.setItem('make-real-png:last-result', JSON.stringify(last));
    sessionStorage.setItem('make-real-png:last-batch', JSON.stringify(records));
    records.forEach((record) => sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record)));
}
function readBatch() { const raw = sessionStorage.getItem('make-real-png:last-batch'); if (raw)
    return JSON.parse(raw); const single = readRecord(); return single ? [single] : []; }
function readRecord(id) { const key = id ? `make-real-png:result:${id}` : 'make-real-png:last-result'; const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
function updateStoredRecord(record) {
    const previousLast = readRecord();
    if (!previousLast || previousLast.id === record.id)
        sessionStorage.setItem('make-real-png:last-result', JSON.stringify(record));
    sessionStorage.setItem(`make-real-png:result:${record.id}`, JSON.stringify(record));
    const batch = readBatch().map((item) => item.id === record.id ? record : item);
    sessionStorage.setItem('make-real-png:last-batch', JSON.stringify(batch));
}
function withSavedEditSettings(record, settings) { return { ...record, editSettings: { ...record.editSettings, ...settings, updatedAt: Date.now() } }; }
function saveVault(user) { const batch = readBatch(); localStorage.setItem('make-real-png:user', JSON.stringify(user)); localStorage.setItem(`make-real-png:vault:${user.email}`, JSON.stringify(batch)); }
function downloadBlob(blob, fileName) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); }
const APP_BASENAME = window.location.pathname.split('/').filter(Boolean)[0] === 'make-real-png' ? '/make-real-png' : '';
function toAppPath(pathname) { const path = pathname.startsWith(APP_BASENAME) ? pathname.slice(APP_BASENAME.length) || '/' : pathname; return path.startsWith('/') ? path : `/${path}`; }
function toBrowserPath(appPath) { const normalizedPath = appPath.startsWith('/') ? appPath : `/${appPath}`; return `${APP_BASENAME}${normalizedPath === '/' ? '/' : normalizedPath}`; }
function navigateTo(to) { window.dispatchEvent(new CustomEvent('app:navigate', { detail: to })); }
function Link({ to, className, children }) { return React.createElement("a", { href: toBrowserPath(to), className: className, onClick: (event) => { event.preventDefault(); navigateTo(to); } }, children); }
function useNavigate() { return navigateTo; }
function useParams() { const match = toAppPath(window.location.pathname).match(/\/mobile-download\/([^/]+)/); return { id: match?.[1] }; }
function App() {
    const [path, setPath] = React.useState(toAppPath(window.location.pathname));
    React.useEffect(() => {
        const onNavigate = (event) => { const to = event.detail; window.history.pushState({}, '', toBrowserPath(to)); setPath(toAppPath(window.location.pathname)); };
        const onPop = () => setPath(toAppPath(window.location.pathname));
        window.addEventListener('app:navigate', onNavigate);
        window.addEventListener('popstate', onPop);
        return () => { window.removeEventListener('app:navigate', onNavigate); window.removeEventListener('popstate', onPop); };
    }, []);
    if (path.startsWith('/mobile-download/'))
        return React.createElement(MobileDownloadPage, null);
    if (path === '/result')
        return React.createElement(ResultPage, null);
    if (path === '/auth')
        return React.createElement(AuthPage, null);
    return React.createElement(LandingPage, null);
}
function LandingPage() {
    const navigate = useNavigate();
    const [uploadedFiles, setUploadedFiles] = React.useState([]);
    const [originalUrls, setOriginalUrls] = React.useState([]);
    const [options, setOptions] = React.useState(defaultOptions);
    const [stage, setStage] = React.useState('idle');
    const [progress, setProgress] = React.useState('');
    const [error, setError] = React.useState(null);
    const handleFiles = (files) => {
        const nextFiles = Array.from(files || []);
        if (!nextFiles.length)
            return;
        const invalid = nextFiles.map(validateFile).find(Boolean);
        if (invalid) {
            setError(invalid);
            return;
        }
        originalUrls.forEach((url) => URL.revokeObjectURL(url));
        setError(null);
        setUploadedFiles(nextFiles);
        setOriginalUrls(nextFiles.map((file) => URL.createObjectURL(file)));
    };
    const removeFile = (index) => { URL.revokeObjectURL(originalUrls[index]); setUploadedFiles((files) => files.filter((_, i) => i !== index)); setOriginalUrls((urls) => urls.filter((_, i) => i !== index)); };
    const startProcess = async () => {
        if (!uploadedFiles.length)
            return;
        try {
            const batchId = crypto.randomUUID();
            const records = [];
            for (let index = 0; index < uploadedFiles.length; index += 1) {
                const file = uploadedFiles[index];
                setProgress(`${index + 1}/${uploadedFiles.length} · ${file.name}`);
                const resultUrl = await removeBackground(file, options, setStage);
                records.push({ id: crypto.randomUUID(), batchId, originalUrl: originalUrls[index], resultUrl, fileName: file.name, options, createdAt: Date.now() });
            }
            saveRecords(records);
            navigate('/result');
        }
        catch {
            setError({ type: 'ai-failed', message: ERROR_MESSAGES['ai-failed'] });
            setStage('idle');
            setProgress('');
        }
    };
    const reset = () => { originalUrls.forEach((url) => URL.revokeObjectURL(url)); setUploadedFiles([]); setOriginalUrls([]); setError(null); setStage('idle'); setProgress(''); };
    if (stage !== 'idle' && stage !== 'done')
        return React.createElement(ProcessingScreen, { stage: stage, progress: progress });
    return React.createElement("main", { className: "min-h-screen bg-slate-50 text-slate-950" },
        React.createElement("section", { className: "mx-auto grid max-w-7xl gap-10 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16" },
            React.createElement("div", { className: "flex flex-col justify-center" },
                React.createElement("span", { className: "w-fit rounded-full bg-blue-100 px-4 py-2 text-sm font-semibold text-blue-700" }, "QR \uBAA8\uBC14\uC77C \uC800\uC7A5 \uD2B9\uD654 MVP"),
                React.createElement("h1", { className: "mt-6 text-4xl font-extrabold tracking-tight md:text-6xl" }, "AI \uBC30\uACBD \uC81C\uAC70 \uD6C4, \uBAA8\uBC14\uC77C \uC800\uC7A5\uAE4C\uC9C0 \uD55C \uBC88\uC5D0"),
                React.createElement("p", { className: "mt-5 text-lg leading-8 text-slate-600" }, "\uC774\uBBF8\uC9C0\uB97C \uC5EC\uB7EC \uC7A5 \uC5C5\uB85C\uB4DC\uD558\uBA74 \uAC00\uC7A5\uC790\uB9AC \uBC30\uACBD\uC0C9\uC744 \uAC10\uC9C0\uD574 \uC2E4\uC81C \uD22C\uBA85 PNG \uACB0\uACFC\uB97C \uB9CC\uB4E4\uACE0 PNG/WebP/JPG/ZIP \uB2E4\uC6B4\uB85C\uB4DC\uC640 QR\uCF54\uB4DC \uBAA8\uBC14\uC77C \uC800\uC7A5 \uB9C1\uD06C\uB97C \uC81C\uACF5\uD569\uB2C8\uB2E4."),
                React.createElement("div", { className: "mt-8 flex flex-wrap gap-3" },
                    React.createElement("a", { href: "#upload", className: "rounded-2xl bg-blue-600 px-6 py-4 font-bold text-white shadow-lg shadow-blue-200" }, "\uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC\uD558\uAE30"),
                    React.createElement("button", { onClick: () => createSample((file) => handleFiles([file])), className: "rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800" }, "\uC0D8\uD50C \uC774\uBBF8\uC9C0\uB85C \uCCB4\uD5D8\uD558\uAE30"),
                    React.createElement(Link, { to: "/auth", className: "rounded-2xl border border-slate-200 bg-white px-6 py-4 font-bold text-slate-800" }, "\uD68C\uC6D0\uAC00\uC785/\uB85C\uADF8\uC778")),
                React.createElement("div", { className: "mt-8 grid gap-3 text-sm text-slate-500 sm:grid-cols-3" },
                    React.createElement(Info, { label: "\uC9C0\uC6D0 \uD615\uC2DD", value: "JPG, PNG, WebP" }),
                    React.createElement(Info, { label: "\uCD5C\uB300 \uC6A9\uB7C9", value: "10MB/\uC7A5" }),
                    React.createElement(Info, { label: "\uB2E4\uC911 \uC5C5\uB85C\uB4DC", value: "\uC5EC\uB7EC \uC7A5 \uB3D9\uC2DC \uCC98\uB9AC" }))),
            React.createElement("div", { id: "upload", className: "rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/70" },
                React.createElement(UploadBox, { onFiles: handleFiles }),
                error && React.createElement(ErrorState, { error: error, onRetry: () => setError(null), onNew: reset }),
                uploadedFiles.length > 0 && React.createElement(FilePreviewList, { files: uploadedFiles, imageUrls: originalUrls, onRemove: removeFile }),
                React.createElement(ProcessingOptionsPanel, { options: options, onChange: setOptions }),
                React.createElement("button", { disabled: !uploadedFiles.length, onClick: startProcess, className: "mt-5 w-full rounded-2xl bg-slate-950 px-6 py-4 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300" }, uploadedFiles.length > 1 ? `${uploadedFiles.length}개 이미지 배경 제거 시작` : '배경 제거 시작'))));
}
function Info({ label, value }) { return React.createElement("div", { className: "rounded-2xl border border-slate-200 bg-white p-4" },
    React.createElement("p", { className: "font-bold text-slate-900" }, label),
    React.createElement("p", null, value)); }
function UploadBox({ onFiles }) { return React.createElement("label", { onDragOver: (e) => e.preventDefault(), onDrop: (e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }, className: "flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-300 bg-blue-50/60 p-10 text-center" },
    React.createElement("span", { className: "text-5xl" }, "\uD83D\uDDBC\uFE0F"),
    React.createElement("strong", { className: "mt-4 text-xl" }, "\uC774\uBBF8\uC9C0\uB97C \uC5EC\uB7EC \uC7A5 \uB4DC\uB798\uADF8 \uC564 \uB4DC\uB86D\uD558\uC138\uC694"),
    React.createElement("span", { className: "mt-2 text-slate-500" }, "\uB610\uB294 \uD30C\uC77C \uC120\uD0DD \uC5C5\uB85C\uB4DC \uBC84\uD2BC\uC744 \uB20C\uB7EC \uB2E4\uC911 \uC120\uD0DD\uD558\uC138\uC694."),
    React.createElement("span", { className: "mt-5 rounded-xl bg-blue-600 px-5 py-3 font-bold text-white" }, "\uD30C\uC77C \uC120\uD0DD \uC5C5\uB85C\uB4DC"),
    React.createElement("input", { className: "sr-only", type: "file", multiple: true, accept: "image/jpeg,image/png,image/webp", onChange: (e) => onFiles(e.target.files) })); }
function FilePreviewList({ files, imageUrls, onRemove }) { return React.createElement("div", { className: "mt-5 grid gap-3" },
    React.createElement("div", { className: "flex items-center justify-between" },
        React.createElement("p", { className: "font-bold" },
            "\uC5C5\uB85C\uB4DC\uB41C \uC774\uBBF8\uC9C0 ",
            files.length,
            "\uAC1C"),
        React.createElement("p", { className: "text-sm text-emerald-600" }, "\uC804\uCCB4 \uAC80\uC99D \uC644\uB8CC")),
    files.map((file, index) => React.createElement("div", { key: `${file.name}-${index}`, className: "flex items-center gap-4 rounded-2xl border border-slate-200 p-4" },
        React.createElement("img", { src: imageUrls[index], className: "h-20 w-20 rounded-xl object-cover" }),
        React.createElement("div", { className: "min-w-0 flex-1" },
            React.createElement("p", { className: "truncate font-bold" }, file.name),
            React.createElement("p", { className: "text-sm text-slate-500" }, formatSize(file.size))),
        React.createElement("button", { onClick: () => onRemove(index), className: "rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold" }, "\uC81C\uAC70")))); }
function ProcessingOptionsPanel({ options, onChange }) { const modes = [{ id: 'basic', label: '기본 배경 제거' }, { id: 'person', label: '인물 우선 모드' }, { id: 'product', label: '제품/사물 우선 모드' }]; const toggles = [{ key: 'smoothEdges', label: '가장자리 부드럽게' }, { key: 'autoTrim', label: '여백 자동 정리' }, { key: 'keepOriginalSize', label: '원본 크기 유지' }]; return React.createElement("section", { className: "mt-5 rounded-2xl bg-slate-50 p-4" },
    React.createElement("h2", { className: "font-bold" }, "\uCC98\uB9AC \uC635\uC158"),
    React.createElement("div", { className: "mt-3 grid gap-2" }, modes.map((mode) => React.createElement("button", { key: mode.id, onClick: () => onChange({ ...options, mode: mode.id }), className: `rounded-xl border p-3 text-left ${options.mode === mode.id ? 'border-blue-500 bg-blue-50 font-bold text-blue-700' : 'border-slate-200 bg-white'}` }, mode.label))),
    React.createElement("label", { className: "mt-4 block rounded-xl bg-white p-3 text-sm font-semibold" },
        "\uBC30\uACBD \uC81C\uAC70 \uAC15\uB3C4: ",
        options.strength,
        React.createElement("input", { type: "range", min: "18", max: "70", value: options.strength, onChange: (e) => onChange({ ...options, strength: Number(e.target.value) }), className: "mt-2 w-full" })),
    React.createElement("div", { className: "mt-4 grid gap-2 sm:grid-cols-3" }, toggles.map((toggle) => React.createElement("label", { key: toggle.key, className: "flex items-center gap-2 rounded-xl bg-white p-3 text-sm" },
        React.createElement("input", { type: "checkbox", checked: options[toggle.key], onChange: (e) => onChange({ ...options, [toggle.key]: e.target.checked }) }),
        toggle.label)))); }
function ProcessingScreen({ stage, progress }) { const steps = ['uploading', 'analyzing', 'removing', 'generating']; const current = steps.indexOf(stage); return React.createElement("main", { className: "flex min-h-screen items-center justify-center bg-slate-950 p-5 text-white" },
    React.createElement("div", { className: "w-full max-w-xl rounded-3xl bg-white/10 p-8" },
        React.createElement("div", { className: "mx-auto h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-blue-400" }),
        React.createElement("h1", { className: "mt-6 text-center text-3xl font-extrabold" }, stageLabels[stage]),
        progress && React.createElement("p", { className: "mt-2 text-center text-blue-100" }, progress),
        React.createElement("div", { className: "mt-8 space-y-3" }, steps.map((step, index) => React.createElement("div", { key: step, className: `rounded-2xl p-4 ${index <= current ? 'bg-blue-500' : 'bg-white/10'}` }, stageLabels[step]))))); }
function ResultPage() {
    const navigate = useNavigate();
    const [records, setRecords] = React.useState(readBatch());
    const [selectedId, setSelectedId] = React.useState(records[0]?.id || '');
    const selected = records.find((record) => record.id === selectedId) || records[0];
    const initialSettings = selected?.editSettings;
    const [background, setBackground] = React.useState(initialSettings?.background || 'transparent');
    const [zoom, setZoom] = React.useState(initialSettings?.zoom || false);
    const [activeTool, setActiveTool] = React.useState(initialSettings?.activeTool || 'strength');
    const [complete, setComplete] = React.useState(false);
    React.useEffect(() => {
        if (!selected)
            return;
        setBackground(selected.editSettings?.background || 'transparent');
        setZoom(selected.editSettings?.zoom || false);
        setActiveTool(selected.editSettings?.activeTool || 'strength');
    }, [selected?.id]);
    if (!selected)
        return React.createElement(MissingResult, null);
    const updateSelected = (record) => { updateStoredRecord(record); setRecords((items) => items.map((item) => item.id === record.id ? record : item)); };
    const saveSelectedSettings = (settings) => updateSelected(withSavedEditSettings(selected, settings));
    const changeBackground = (value) => { setBackground(value); saveSelectedSettings({ background: value }); };
    const changeZoom = (value) => { setZoom(value); saveSelectedSettings({ zoom: value }); };
    const changeTool = (tool) => { setActiveTool(tool); saveSelectedSettings({ activeTool: tool }); };
    return React.createElement("main", { className: "min-h-screen bg-slate-50 px-5 py-8" },
        React.createElement("div", { className: "mx-auto max-w-7xl" },
            React.createElement("header", { className: "flex flex-col justify-between gap-4 md:flex-row md:items-center" },
                React.createElement("div", null,
                    React.createElement("p", { className: "font-bold text-blue-600" }, "\uBC30\uACBD \uC81C\uAC70 \uC644\uB8CC"),
                    React.createElement("h1", { className: "text-3xl font-extrabold" }, "\uACB0\uACFC \uD655\uC778 \uBC0F \uB2E4\uC6B4\uB85C\uB4DC"),
                    React.createElement("p", { className: "mt-1 text-slate-500" },
                        records.length,
                        "\uAC1C \uACB0\uACFC\uAC00 \uBCF4\uAD00 \uB300\uAE30 \uC911\uC785\uB2C8\uB2E4. \uD3B8\uC9D1\uAC12\uC740 \uC801\uC6A9\uD560 \uB54C\uB9C8\uB2E4 \uC774 \uACB0\uACFC\uC5D0 \uC800\uC7A5\uB429\uB2C8\uB2E4.")),
                React.createElement("div", { className: "flex flex-wrap gap-2" },
                    React.createElement(Link, { to: "/auth", className: "rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white" }, "\uD68C\uC6D0\uAC00\uC785/\uB85C\uADF8\uC778\uD558\uACE0 \uACB0\uACFC \uBCF4\uAD00"),
                    React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl bg-white px-5 py-3 font-bold shadow" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))),
            records.length > 1 && React.createElement(ResultStrip, { records: records, selectedId: selected.id, onSelect: setSelectedId }),
            React.createElement("div", { className: "mt-6 grid gap-6 lg:grid-cols-[1fr_380px]" },
                React.createElement("section", { className: "space-y-6" },
                    React.createElement(CompareSlider, { originalUrl: selected.originalUrl, resultUrl: selected.resultUrl, background: background, zoom: zoom }),
                    React.createElement(BackgroundPreviewToggle, { value: background, onChange: changeBackground, zoom: zoom, onZoom: changeZoom }),
                    React.createElement(EditToolbar, { activeTool: activeTool, onAction: changeTool }),
                    React.createElement(EditPanel, { record: selected, activeTool: activeTool, onUpdate: updateSelected }),
                    React.createElement("div", { className: "flex flex-wrap gap-3" },
                        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl border bg-white px-5 py-3 font-bold" }, "\uB2E4\uC2DC \uCC98\uB9AC\uD558\uAE30"),
                        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-2xl border bg-white px-5 py-3 font-bold" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))),
                React.createElement("aside", { className: "space-y-6" },
                    React.createElement(DownloadPanel, { record: selected, records: records, onComplete: () => setComplete(true) }),
                    React.createElement(QRDownloadPanel, { record: selected }),
                    React.createElement(CompletionPanel, { show: complete, onResult: () => setComplete(false) })))));
}
function ResultStrip({ records, selectedId, onSelect }) { return React.createElement("section", { className: "mt-6 rounded-3xl bg-white p-4 shadow" },
    React.createElement("h2", { className: "font-bold" }, "\uB2E4\uC911 \uC5C5\uB85C\uB4DC \uACB0\uACFC"),
    React.createElement("div", { className: "mt-3 flex gap-3 overflow-x-auto pb-2" }, records.map((record, index) => React.createElement("button", { key: record.id, onClick: () => onSelect(record.id), className: `min-w-40 rounded-2xl border p-3 text-left ${record.id === selectedId ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}` },
        React.createElement("img", { src: record.resultUrl, className: "checker h-24 w-full rounded-xl object-contain" }),
        React.createElement("p", { className: "mt-2 truncate text-sm font-bold" },
            index + 1,
            ". ",
            record.fileName))))); }
function CompareSlider({ originalUrl, resultUrl, background, zoom }) { const [split, setSplit] = React.useState(50); const bgClass = background === 'transparent' ? 'checker' : background === 'white' ? 'bg-white' : 'bg-slate-950'; return React.createElement("div", { className: `relative overflow-hidden rounded-3xl border border-slate-200 ${bgClass}` },
    React.createElement("img", { src: resultUrl, className: `mx-auto h-[460px] w-full object-contain ${zoom ? 'scale-125' : ''}` }),
    React.createElement("div", { className: "absolute inset-0 overflow-hidden", style: { width: `${split}%` } },
        React.createElement("img", { src: originalUrl, className: `h-[460px] w-full max-w-none object-contain ${zoom ? 'scale-125' : ''}` })),
    React.createElement("input", { "aria-label": "\uC6D0\uBCF8 \uACB0\uACFC \uBE44\uAD50 \uC2AC\uB77C\uC774\uB354", type: "range", min: "0", max: "100", value: split, onChange: (e) => setSplit(Number(e.target.value)), className: "absolute bottom-5 left-1/2 w-3/4 -translate-x-1/2" }),
    React.createElement("span", { className: "absolute left-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold" }, "\uC6D0\uBCF8"),
    React.createElement("span", { className: "absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-bold" }, "\uACB0\uACFC")); }
function BackgroundPreviewToggle({ value, onChange, zoom, onZoom }) { return React.createElement("div", { className: "rounded-3xl bg-white p-4 shadow" },
    React.createElement("h2", { className: "font-bold" }, "\uBC30\uACBD \uBBF8\uB9AC\uBCF4\uAE30"),
    React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
        ['transparent', 'white', 'black'].map((mode) => React.createElement("button", { key: mode, onClick: () => onChange(mode), className: `rounded-xl px-4 py-2 font-bold ${value === mode ? 'bg-blue-600 text-white' : 'bg-slate-100'}` }, mode === 'transparent' ? '투명(체크무늬 미리보기)' : mode === 'white' ? '흰 배경' : '검은 배경')),
        React.createElement("button", { onClick: () => onZoom(!zoom), className: "rounded-xl bg-slate-900 px-4 py-2 font-bold text-white" }, "\uD655\uB300\uD574\uC11C \uAC00\uC7A5\uC790\uB9AC \uD655\uC778"))); }
function EditToolbar({ activeTool, onAction }) { return React.createElement("div", { className: "rounded-3xl bg-white p-4 shadow" },
    React.createElement("h2", { className: "font-bold" }, "\uAC04\uB2E8 \uD3B8\uC9D1 UI"),
    React.createElement("div", { className: "mt-3 grid gap-2 sm:grid-cols-3" }, Object.keys(toolLabels).map((tool) => React.createElement("button", { key: tool, onClick: () => onAction(tool), className: `rounded-xl border px-4 py-3 font-semibold hover:bg-slate-50 ${activeTool === tool ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200'}` }, toolLabels[tool])))); }
function EditPanel({ record, activeTool, onUpdate }) {
    const savedCrop = record.editSettings?.crop || { top: 0, right: 0, bottom: 0, left: 0 };
    const [value, setValue] = React.useState(record.editSettings?.strength || record.options.strength);
    const [brush, setBrush] = React.useState(record.editSettings?.brush || 34);
    const [crop, setCrop] = React.useState(savedCrop);
    const [padding, setPadding] = React.useState(record.editSettings?.padding ?? 40);
    const [name, setName] = React.useState(record.fileName);
    const [busy, setBusy] = React.useState(false);
    const [savedMessage, setSavedMessage] = React.useState('');
    React.useEffect(() => {
        setValue(record.editSettings?.strength || record.options.strength);
        setBrush(record.editSettings?.brush || 34);
        setCrop(record.editSettings?.crop || { top: 0, right: 0, bottom: 0, left: 0 });
        setPadding(record.editSettings?.padding ?? 40);
        setName(record.fileName);
        setSavedMessage('');
    }, [record.id]);
    const finishUpdate = (nextRecord, message) => { onUpdate(nextRecord); setSavedMessage(message); };
    const apply = async (job, message = '편집이 결과 이미지에 적용되어 저장되었습니다.') => { setBusy(true); setSavedMessage(''); try {
        finishUpdate(await job(), message);
    }
    finally {
        setBusy(false);
    } };
    const rememberSettings = (settings) => { onUpdate(withSavedEditSettings(record, settings)); setSavedMessage('설정값을 저장했습니다.'); };
    const savedNotice = savedMessage ? React.createElement("p", { className: "mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700" }, savedMessage) : null;
    if (activeTool === 'strength')
        return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
            React.createElement("h3", { className: "font-extrabold" }, "\uBC30\uACBD \uC81C\uAC70 \uAC15\uB3C4 \uC870\uC815"),
            React.createElement("p", { className: "mt-2 text-sm text-slate-500" }, "\uAC12\uC744 \uC6C0\uC9C1\uC778 \uB4A4 \uC801\uC6A9\uD558\uBA74 \uACB0\uACFC \uC774\uBBF8\uC9C0\uAC00 \uB2E4\uC2DC \uB9CC\uB4E4\uC5B4\uC9C0\uACE0 \uB2E4\uC6B4\uB85C\uB4DC/QR\uC5D0\uB3C4 \uBC18\uC601\uB429\uB2C8\uB2E4."),
            React.createElement("input", { type: "range", min: "18", max: "70", value: value, onChange: (e) => setValue(Number(e.target.value)), className: "mt-4 w-full" }),
            React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                React.createElement("button", { disabled: busy, onClick: () => apply(async () => withSavedEditSettings({ ...record, options: { ...record.options, strength: value }, resultUrl: await rebuildWithStrength(record.originalUrl, { ...record.options, strength: value }) }, { strength: value })), className: "rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white disabled:bg-slate-300" },
                    "\uAC15\uB3C4 ",
                    value,
                    "\uB85C \uC801\uC6A9\uD558\uACE0 \uC800\uC7A5"),
                React.createElement("button", { disabled: busy, onClick: () => rememberSettings({ strength: value }), className: "rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200 disabled:text-slate-400" }, "\uAC12\uB9CC \uC800\uC7A5")),
            savedNotice);
    if (activeTool === 'eraser' || activeTool === 'restore')
        return React.createElement(BrushEditor, { record: record, mode: activeTool, brush: brush, onBrush: (nextBrush) => { setBrush(nextBrush); rememberSettings({ brush: nextBrush }); }, onUpdate: onUpdate });
    if (activeTool === 'crop')
        return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
            React.createElement("h3", { className: "font-extrabold" }, "\uC774\uBBF8\uC9C0 \uC790\uB974\uAE30"),
            React.createElement("div", { className: "mt-3 grid grid-cols-2 gap-2" }, ['top', 'right', 'bottom', 'left'].map((side) => React.createElement("label", { key: side, className: "rounded-xl bg-slate-50 p-3 text-sm font-semibold" },
                side,
                React.createElement("input", { type: "number", min: "0", value: crop[side], onChange: (e) => setCrop({ ...crop, [side]: Math.max(0, Number(e.target.value)) }), className: "mt-1 w-full rounded-lg border p-2" })))),
            React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                React.createElement("button", { disabled: busy, onClick: () => apply(async () => withSavedEditSettings({ ...record, resultUrl: await cropImage(record.resultUrl, crop) }, { crop })), className: "rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white disabled:bg-slate-300" }, "\uC790\uB974\uAE30 \uC801\uC6A9\uD558\uACE0 \uC800\uC7A5"),
                React.createElement("button", { disabled: busy, onClick: () => rememberSettings({ crop }), className: "rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200 disabled:text-slate-400" }, "\uAC12\uB9CC \uC800\uC7A5")),
            savedNotice);
    if (activeTool === 'padding')
        return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
            React.createElement("h3", { className: "font-extrabold" }, "\uC5EC\uBC31 \uCD94\uAC00/\uC81C\uAC70"),
            React.createElement("label", { className: "mt-3 block text-sm font-semibold" },
                "\uCD94\uAC00\uD560 \uD22C\uBA85 \uC5EC\uBC31 ",
                padding,
                "px",
                React.createElement("input", { type: "range", min: "0", max: "240", value: padding, onChange: (e) => setPadding(Number(e.target.value)), className: "mt-2 w-full" })),
            React.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                React.createElement("button", { disabled: busy, onClick: () => apply(async () => withSavedEditSettings({ ...record, resultUrl: await padImage(record.resultUrl, padding) }, { padding })), className: "rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white disabled:bg-slate-300" }, "\uC5EC\uBC31 \uCD94\uAC00\uD558\uACE0 \uC800\uC7A5"),
                React.createElement("button", { disabled: busy, onClick: () => apply(async () => withSavedEditSettings({ ...record, resultUrl: await trimImage(record.resultUrl) }, { padding: 0 })), className: "rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white disabled:bg-slate-300" }, "\uD22C\uBA85 \uC5EC\uBC31 \uC81C\uAC70\uD558\uACE0 \uC800\uC7A5"),
                React.createElement("button", { disabled: busy, onClick: () => rememberSettings({ padding }), className: "rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200 disabled:text-slate-400" }, "\uAC12\uB9CC \uC800\uC7A5")),
            savedNotice);
    return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
        React.createElement("h3", { className: "font-extrabold" }, "\uD30C\uC77C\uBA85 \uC218\uC815"),
        React.createElement("input", { value: name, onChange: (e) => setName(e.target.value), className: "mt-3 w-full rounded-xl border p-3" }),
        React.createElement("button", { onClick: () => finishUpdate(withSavedEditSettings({ ...record, fileName: name.trim() || record.fileName }, {}), '파일명을 저장했습니다. 다운로드 파일명에 반영됩니다.'), className: "mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white" }, "\uD30C\uC77C\uBA85 \uC800\uC7A5"),
        savedNotice);
}
function BrushEditor({ record, mode, brush, onBrush, onUpdate }) {
    const canvasRef = React.useRef(null);
    const [ready, setReady] = React.useState(false);
    const [drawing, setDrawing] = React.useState(false);
    React.useEffect(() => { (async () => { const result = await loadImage(record.resultUrl); const canvas = canvasRef.current; const ctx = canvas?.getContext('2d'); if (!canvas || !ctx)
        return; canvas.width = result.naturalWidth || result.width; canvas.height = result.naturalHeight || result.height; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(result, 0, 0); setReady(true); })(); }, [record.id, record.resultUrl]);
    const paint = async (event) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx)
            return;
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (canvas.width / rect.width);
        const y = (event.clientY - rect.top) * (canvas.height / rect.height);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, brush, 0, Math.PI * 2);
        ctx.clip();
        if (mode === 'eraser') {
            ctx.clearRect(x - brush, y - brush, brush * 2, brush * 2);
        }
        else {
            const original = await loadImage(record.originalUrl);
            ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
        }
        ctx.restore();
    };
    const save = async () => { const canvas = canvasRef.current; if (!canvas)
        return; onUpdate(withSavedEditSettings({ ...record, resultUrl: await canvasToObjectUrl(canvas) }, { brush })); };
    return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
        React.createElement("h3", { className: "font-extrabold" }, mode === 'eraser' ? '지우개' : '복원 브러시'),
        React.createElement("p", { className: "mt-2 text-sm text-slate-500" },
            "\uCE94\uBC84\uC2A4 \uC704\uC5D0\uC11C \uB4DC\uB798\uADF8\uD574 ",
            mode === 'eraser' ? '투명하게 지우거나' : '원본 픽셀을 되살리고',
            " \uC800\uC7A5\uD558\uC138\uC694."),
        React.createElement("label", { className: "mt-3 block text-sm font-semibold" },
            "\uBE0C\uB7EC\uC2DC \uD06C\uAE30 ",
            brush,
            "px",
            React.createElement("input", { type: "range", min: "8", max: "120", value: brush, onChange: (e) => onBrush(Number(e.target.value)), className: "mt-2 w-full" })),
        React.createElement("canvas", { ref: canvasRef, onPointerDown: (e) => { setDrawing(true); paint(e); }, onPointerMove: (e) => drawing && paint(e), onPointerUp: () => setDrawing(false), onPointerLeave: () => setDrawing(false), className: "checker mt-4 max-h-[420px] w-full touch-none rounded-2xl border object-contain" }),
        React.createElement("button", { disabled: !ready, onClick: save, className: "mt-3 rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white disabled:bg-slate-300" }, "\uD3B8\uC9D1 \uC800\uC7A5"));
}
async function rebuildWithStrength(originalUrl, options) { const image = await loadImage(originalUrl); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const ctx = canvas.getContext('2d'); if (!ctx)
    throw new Error('Canvas를 생성할 수 없습니다.'); ctx.drawImage(image, 0, 0); const blob = await imageDataToBlob(canvas); return removeBackgroundLocally(new File([blob], 'edited-source.png', { type: 'image/png' }), options); }
async function cropImage(url, crop) { const image = await loadImage(url); const width = Math.max(1, (image.naturalWidth || image.width) - crop.left - crop.right); const height = Math.max(1, (image.naturalHeight || image.height) - crop.top - crop.bottom); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d')?.drawImage(image, crop.left, crop.top, width, height, 0, 0, width, height); return canvasToObjectUrl(canvas); }
async function padImage(url, padding) { const image = await loadImage(url); const canvas = document.createElement('canvas'); canvas.width = (image.naturalWidth || image.width) + padding * 2; canvas.height = (image.naturalHeight || image.height) + padding * 2; canvas.getContext('2d')?.drawImage(image, padding, padding); return canvasToObjectUrl(canvas); }
async function trimImage(url) { const image = await loadImage(url); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height; const ctx = canvas.getContext('2d'); if (!ctx)
    throw new Error('Canvas를 생성할 수 없습니다.'); ctx.drawImage(image, 0, 0); return canvasToObjectUrl(trimTransparentPixels(ctx.getImageData(0, 0, canvas.width, canvas.height))); }
function DownloadPanel({ record, records, onComplete }) { const baseName = record.fileName.replace(/\.[^/.]+$/, '') || 'result'; const handleDownload = async (format) => { const blob = await generateDownloadBlob(record.resultUrl, format); downloadBlob(blob, `${baseName}-background-removed.${format}`); onComplete(); }; const handleZip = async () => { downloadBlob(await createZip(records), `make-real-png-${records.length}-results.zip`); onComplete(); }; return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
    React.createElement("h2", { className: "text-xl font-extrabold" }, "\uB2E4\uC6B4\uB85C\uB4DC"),
    React.createElement("p", { className: "mt-2 text-sm text-slate-500" }, "\uD22C\uBA85 \uBBF8\uB9AC\uBCF4\uAE30\uC758 \uCCB4\uD06C\uBB34\uB2AC\uB294 \uD30C\uC77C\uC5D0 \uC800\uC7A5\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."),
    React.createElement("div", { className: "mt-4 grid gap-3" },
        React.createElement("button", { onClick: () => handleDownload('png'), className: "rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white" }, "PNG \uD22C\uBA85 \uBC30\uACBD \uB2E4\uC6B4\uB85C\uB4DC"),
        React.createElement("button", { onClick: () => handleDownload('webp'), className: "rounded-2xl bg-slate-900 px-5 py-3 font-bold text-white" }, "WebP \uB2E4\uC6B4\uB85C\uB4DC"),
        React.createElement("button", { onClick: () => handleDownload('jpg'), className: "rounded-2xl bg-white px-5 py-3 font-bold text-slate-900 ring-1 ring-slate-200" }, "JPG \uD770 \uBC30\uACBD \uB2E4\uC6B4\uB85C\uB4DC"),
        React.createElement("button", { onClick: handleZip, disabled: records.length < 2, className: "rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500" },
            "ZIP \uB2E4\uC6B4\uB85C\uB4DC \u00B7 ",
            records.length,
            "\uAC1C \uACB0\uACFC"))); }
async function createZip(records) { const files = await Promise.all(records.map(async (record, index) => ({ name: `${String(index + 1).padStart(2, '0')}-${(record.fileName.replace(/\.[^/.]+$/, '') || 'result')}.png`, data: new Uint8Array(await (await generateDownloadBlob(record.resultUrl, 'png')).arrayBuffer()) }))); const encoder = new TextEncoder(); const chunks = []; const central = []; let offset = 0; const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]); const u32 = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); const concat = (...parts) => { const length = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(length); let cursor = 0; parts.forEach((part) => { output.set(part, cursor); cursor += part.length; }); return output; }; files.forEach((file) => { const name = encoder.encode(file.name); const crc = crc32(file.data); const local = concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), name, file.data); chunks.push(local); central.push(concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name)); offset += local.length; }); const centralSize = central.reduce((sum, part) => sum + part.length, 0); return new Blob([...chunks, ...central, concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0))], { type: 'application/zip' }); }
function crc32(data) { let crc = -1; for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
} return (crc ^ -1) >>> 0; }
function QRDownloadPanel({ record }) { const [qr, setQr] = React.useState(''); const mobileUrl = React.useMemo(() => `${window.location.origin}${toBrowserPath(`/mobile-download/${record.id}`)}`, [record.id]); const createQr = async () => setQr(await generateQRCode(mobileUrl)); return React.createElement("section", { className: "rounded-3xl bg-white p-5 shadow" },
    React.createElement("h2", { className: "text-xl font-extrabold" }, "QR \uBAA8\uBC14\uC77C \uC800\uC7A5"),
    React.createElement("p", { className: "mt-2 text-sm text-slate-500" }, "\uBAA8\uBC14\uC77C\uC5D0\uC11C QR\uCF54\uB4DC\uB97C \uC2A4\uCE94\uD558\uBA74 \uC120\uD0DD\uD55C \uACB0\uACFC \uC774\uBBF8\uC9C0\uB97C \uC800\uC7A5\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."),
    React.createElement("button", { onClick: createQr, className: "mt-4 w-full rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white" }, "QR\uCF54\uB4DC \uC0DD\uC131"),
    qr && React.createElement("div", { className: "mt-4 rounded-2xl border p-4 text-center" },
        React.createElement("img", { src: qr, className: "mx-auto" }),
        React.createElement("p", { className: "mt-3 break-all text-xs text-slate-500" }, mobileUrl))); }
function CompletionPanel({ show, onResult }) { const navigate = useNavigate(); if (!show)
    return null; return React.createElement("section", { className: "rounded-3xl bg-blue-50 p-5" },
    React.createElement("h2", { className: "text-xl font-extrabold text-blue-900" }, "\uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4"),
    React.createElement("div", { className: "mt-4 grid gap-2" },
        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-xl bg-blue-600 px-4 py-3 font-bold text-white" }, "\uB2E4\uB978 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"),
        React.createElement("button", { onClick: () => navigate('/'), className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uAC19\uC740 \uC635\uC158\uC73C\uB85C \uC0C8 \uC774\uBBF8\uC9C0 \uCC98\uB9AC"),
        React.createElement("button", { onClick: onResult, className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uACB0\uACFC \uB2E4\uC2DC \uBCF4\uAE30"),
        React.createElement("button", { onClick: () => navigator.share?.({ title: 'Make Real PNG', url: location.href }), className: "rounded-xl bg-white px-4 py-3 font-bold" }, "\uC11C\uBE44\uC2A4 \uACF5\uC720\uD558\uAE30"),
        React.createElement("button", { onClick: () => navigate('/auth'), className: "rounded-xl bg-slate-950 px-4 py-3 font-bold text-white" }, "\uD68C\uC6D0\uAC00\uC785/\uB85C\uADF8\uC778\uD558\uACE0 \uACB0\uACFC \uBCF4\uAD00"))); }
function AuthPage() { const navigate = useNavigate(); const [mode, setMode] = React.useState('signup'); const [email, setEmail] = React.useState(''); const [name, setName] = React.useState(''); const [saved, setSaved] = React.useState(false); const submit = (event) => { event.preventDefault(); saveVault({ email, name: name || email.split('@')[0], createdAt: Date.now() }); setSaved(true); }; return React.createElement("main", { className: "flex min-h-screen items-center justify-center bg-slate-50 p-5" },
    React.createElement("section", { className: "w-full max-w-lg rounded-3xl bg-white p-8 shadow-xl" },
        React.createElement("p", { className: "font-bold text-blue-600" }, "\uACB0\uACFC \uBCF4\uAD00 \uACC4\uC815"),
        React.createElement("h1", { className: "mt-2 text-3xl font-extrabold" }, "\uD68C\uC6D0\uAC00\uC785/\uB85C\uADF8\uC778"),
        React.createElement("p", { className: "mt-3 text-slate-500" }, "MVP\uC5D0\uC11C\uB294 \uBE0C\uB77C\uC6B0\uC800 \uB85C\uCEEC \uC800\uC7A5\uC18C\uC5D0 \uACC4\uC815 \uC0C1\uD0DC\uC640 \uACB0\uACFC \uBB36\uC74C\uC744 \uBCF4\uAD00\uD569\uB2C8\uB2E4. \uC11C\uBC84 \uC5F0\uB3D9 \uC2DC \uC774 \uD654\uBA74\uC744 \uC2E4\uC81C \uC778\uC99D API\uC640 \uC5F0\uACB0\uD558\uBA74 \uB429\uB2C8\uB2E4."),
        React.createElement("div", { className: "mt-5 grid grid-cols-2 gap-2" },
            React.createElement("button", { onClick: () => setMode('signup'), className: `rounded-xl p-3 font-bold ${mode === 'signup' ? 'bg-blue-600 text-white' : 'bg-slate-100'}` }, "\uD68C\uC6D0\uAC00\uC785"),
            React.createElement("button", { onClick: () => setMode('login'), className: `rounded-xl p-3 font-bold ${mode === 'login' ? 'bg-blue-600 text-white' : 'bg-slate-100'}` }, "\uB85C\uADF8\uC778")),
        React.createElement("form", { onSubmit: submit, className: "mt-5 grid gap-3" },
            React.createElement("input", { required: true, type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "\uC774\uBA54\uC77C", className: "rounded-xl border p-3" }),
            mode === 'signup' && React.createElement("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "\uC774\uB984", className: "rounded-xl border p-3" }),
            React.createElement("input", { required: true, type: "password", minLength: 6, placeholder: "\uBE44\uBC00\uBC88\uD638", className: "rounded-xl border p-3" }),
            React.createElement("button", { className: "rounded-2xl bg-slate-950 px-5 py-4 font-bold text-white" }, mode === 'signup' ? '회원가입하고 결과 보관' : '로그인하고 결과 보관')),
        saved && React.createElement("div", { className: "mt-5 rounded-2xl bg-emerald-50 p-4 text-emerald-700" },
            React.createElement("p", { className: "font-bold" }, "\uACB0\uACFC\uAC00 \uBCF4\uAD00\uB418\uC5C8\uC2B5\uB2C8\uB2E4."),
            React.createElement("p", { className: "text-sm" },
                "\uBCF4\uAD00\uB41C \uACB0\uACFC ",
                readBatch().length,
                "\uAC1C\uB97C \uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uB2E4\uC2DC \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.")),
        React.createElement("button", { onClick: () => navigate('/result'), className: "mt-4 w-full rounded-2xl bg-blue-600 px-5 py-3 font-bold text-white" }, "\uACB0\uACFC \uD398\uC774\uC9C0\uB85C \uB3CC\uC544\uAC00\uAE30"),
        React.createElement(Link, { to: "/", className: "mt-3 block text-center text-sm font-bold text-slate-500" }, "\uCC98\uC74C\uC73C\uB85C"))); }
function ErrorState({ error, onRetry, onNew }) { return React.createElement("div", { className: "mt-5 rounded-2xl border border-red-200 bg-red-50 p-4" },
    React.createElement("p", { className: "font-bold text-red-700" }, error.message),
    React.createElement("div", { className: "mt-3 flex gap-2" },
        React.createElement("button", { onClick: onRetry, className: "rounded-xl bg-red-600 px-4 py-2 font-bold text-white" }, "\uB2E4\uC2DC \uC2DC\uB3C4"),
        React.createElement("button", { onClick: onNew, className: "rounded-xl bg-white px-4 py-2 font-bold text-red-700" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))); }
function MobileDownloadPage() { const { id } = useParams(); const record = readRecord(id); if (!record)
    return React.createElement(MissingResult, null); return React.createElement("main", { className: "min-h-screen bg-slate-950 p-5 text-white" },
    React.createElement("section", { className: "mx-auto max-w-md rounded-3xl bg-white p-5 text-slate-950" },
        React.createElement("p", { className: "font-bold text-emerald-600" }, "\uBAA8\uBC14\uC77C \uB2E4\uC6B4\uB85C\uB4DC \uD398\uC774\uC9C0"),
        React.createElement("h1", { className: "mt-2 text-2xl font-extrabold" }, "\uACB0\uACFC \uC774\uBBF8\uC9C0\uB97C \uAE38\uAC8C \uB20C\uB7EC \uC800\uC7A5\uD558\uC138\uC694"),
        React.createElement("img", { src: record.resultUrl, className: "checker mt-5 w-full rounded-2xl object-contain" }),
        React.createElement("p", { className: "mt-4 text-sm text-slate-500" }, "iOS/Android \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uC774\uBBF8\uC9C0\uB97C \uAE38\uAC8C \uB204\uB978 \uB4A4 \u201C\uC0AC\uC9C4\uC5D0 \uC800\uC7A5\u201D \uB610\uB294 \u201C\uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC\u201D\uB97C \uC120\uD0DD\uD558\uC138\uC694."),
        React.createElement(Link, { to: "/", className: "mt-5 block rounded-2xl bg-blue-600 px-5 py-3 text-center font-bold text-white" }, "\uB2E4\uB978 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))); }
function MissingResult() { return React.createElement("main", { className: "flex min-h-screen items-center justify-center bg-slate-50 p-5" },
    React.createElement("div", { className: "max-w-md rounded-3xl bg-white p-8 text-center shadow" },
        React.createElement("h1", { className: "text-2xl font-extrabold" }, "\uACB0\uACFC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4"),
        React.createElement("p", { className: "mt-3 text-slate-500" }, "\uBE0C\uB77C\uC6B0\uC800 \uBA54\uBAA8\uB9AC \uAE30\uBC18 MVP\uB77C \uC0C8\uB85C\uACE0\uCE68 \uB610\uB294 24\uC2DC\uAC04 \uB9CC\uB8CC \uD6C4\uC5D0\uB294 \uB2E4\uC2DC \uC5C5\uB85C\uB4DC\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4."),
        React.createElement(Link, { to: "/", className: "mt-6 inline-block rounded-2xl bg-blue-600 px-6 py-3 font-bold text-white" }, "\uC0C8 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC"))); }
function createSample(onFile) { const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600; const ctx = canvas.getContext('2d'); if (!ctx)
    return; ctx.fillStyle = '#dbeafe'; ctx.fillRect(0, 0, 900, 600); ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(450, 260, 120, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#0f172a'; ctx.fillRect(310, 390, 280, 70); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('SAMPLE', 380, 435); canvas.toBlob((blob) => blob && onFile(new File([blob], 'sample-product.png', { type: 'image/png' })), 'image/png'); }
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
    React.createElement(App, null)));
