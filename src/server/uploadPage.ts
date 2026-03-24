type UploadPageOptions = {
  chunkSize: number;
  supportedExtensions: string[];
};

export function buildUploadPage({ chunkSize, supportedExtensions }: UploadPageOptions): string {
  const acceptList = ['video/*', ...supportedExtensions].join(',');
  const supportedExtensionsJson = JSON.stringify(supportedExtensions);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VPlayer Upload</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4ede2;
        --panel: rgba(255, 248, 240, 0.88);
        --ink: #1f1a17;
        --muted: #6f655c;
        --line: rgba(95, 71, 48, 0.14);
        --accent: #c6673d;
        --accent-strong: #9b4927;
        --highlight: #1f6f68;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(214, 142, 96, 0.32), transparent 28%),
          radial-gradient(circle at right center, rgba(44, 110, 102, 0.18), transparent 26%),
          linear-gradient(180deg, #efe3d4 0%, var(--bg) 48%, #f8f3ec 100%);
        padding: 24px;
      }

      body.drag-active {
        overflow: hidden;
      }

      main {
        max-width: 820px;
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }

      .drop-overlay {
        position: fixed;
        inset: 16px;
        display: none;
        align-items: center;
        justify-content: center;
        border-radius: 28px;
        border: 3px dashed rgba(31, 111, 104, 0.65);
        background: rgba(255, 248, 240, 0.82);
        box-shadow: 0 24px 80px rgba(31, 111, 104, 0.12);
        backdrop-filter: blur(10px);
        pointer-events: none;
        z-index: 50;
      }

      body.drag-active .drop-overlay {
        display: flex;
      }

      .drop-overlay-content {
        text-align: center;
        padding: 24px;
      }

      .drop-overlay-title {
        font-size: clamp(28px, 4vw, 44px);
        font-weight: 800;
        line-height: 1;
      }

      .drop-overlay-copy {
        margin-top: 12px;
        font-size: 15px;
        color: var(--muted);
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 60px rgba(38, 25, 16, 0.08);
        backdrop-filter: blur(14px);
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .panel {
        padding: 22px;
      }

      .panel h2 {
        margin: 0 0 10px;
        font-size: 20px;
      }

      .button {
        border: 0;
        border-radius: 18px;
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        color: white;
        padding: 14px 18px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 18px 32px rgba(155, 73, 39, 0.24);
      }

      .button:disabled {
        cursor: wait;
        opacity: 0.7;
      }

      .batch-status {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 18px;
        margin-top: 14px;
        color: var(--muted);
        font-size: 14px;
      }

      .batch-status strong {
        color: var(--ink);
      }

      .queue {
        display: grid;
        gap: 12px;
        margin-top: 16px;
      }

      .upload-item {
        padding: 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid var(--line);
      }

      .upload-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }

      .upload-name {
        font-weight: 700;
        font-size: 15px;
      }

      .upload-state {
        color: var(--muted);
        font-size: 13px;
      }

      .track {
        margin-top: 12px;
        height: 10px;
        border-radius: 999px;
        background: rgba(31, 111, 104, 0.08);
        overflow: hidden;
      }

      .bar {
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--highlight), #5bb4ab);
        transition: width 180ms ease;
      }

      .status-line {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }

      .empty {
        color: var(--muted);
        font-size: 14px;
      }

      code {
        background: rgba(31, 26, 23, 0.08);
        padding: 2px 6px;
        border-radius: 8px;
      }

      @media (max-width: 640px) {
        body {
          padding: 16px;
        }

        .panel {
          border-radius: 20px;
        }

        .upload-row,
        .status-line {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h2>Upload files</h2>
        <p>Keep this page open until the progress reaches 100% and the app confirms the file is saved. You can also drag files anywhere onto this page.</p>
        <div style="margin-top: 18px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
          <button class="button" id="pick-button" type="button">Choose videos</button>
          <span class="empty" id="picker-state">Ready for new uploads.</span>
        </div>
        <div class="batch-status" id="batch-status">
          <span><strong id="batch-progress">0/0</strong> files completed</span>
          <span>Speed <strong id="batch-speed">Idle</strong></span>
        </div>
        <input id="file-input" type="file" accept="${acceptList}" multiple hidden />
        <div class="queue" id="queue">
          <div class="empty">No uploads yet.</div>
        </div>
      </section>
    </main>

    <div class="drop-overlay" id="drop-overlay" aria-hidden="true">
      <div class="drop-overlay-content">
        <div class="drop-overlay-title">Drop videos to upload</div>
        <div class="drop-overlay-copy">Release anywhere on this page and the upload starts immediately.</div>
      </div>
    </div>

    <script>
      const supportedExtensions = ${supportedExtensionsJson};
      const pickButton = document.getElementById('pick-button');
      const fileInput = document.getElementById('file-input');
      const queue = document.getElementById('queue');
      const pickerState = document.getElementById('picker-state');
      const batchProgress = document.getElementById('batch-progress');
      const batchSpeed = document.getElementById('batch-speed');
      const defaultChunkSize = ${chunkSize};
      let dragDepth = 0;
      let totalFilesInBatch = 0;
      let completedFilesInBatch = 0;

      function setPickerState(text) {
        pickerState.textContent = text;
      }

      function formatBytes(bytes) {
        if (!bytes || bytes <= 0) {
          return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const scaled = bytes / Math.pow(1024, index);
        const digits = scaled >= 10 || index === 0 ? 0 : 1;
        return scaled.toFixed(digits) + ' ' + units[index];
      }

      function formatSpeed(bytesPerSecond) {
        if (!bytesPerSecond || bytesPerSecond <= 0) {
          return 'Idle';
        }

        return formatBytes(bytesPerSecond) + '/s';
      }

      function updateBatchStatus(speedBytesPerSecond) {
        batchProgress.textContent = completedFilesInBatch + '/' + totalFilesInBatch;
        batchSpeed.textContent = formatSpeed(speedBytesPerSecond);
      }

      function createUploadCard(file) {
        if (queue.firstElementChild && queue.firstElementChild.className === 'empty') {
          queue.innerHTML = '';
        }

        const item = document.createElement('div');
        item.className = 'upload-item';
        item.innerHTML = [
          '<div class="upload-row">',
          '<div class="upload-name"></div>',
          '<div class="upload-state"></div>',
          '</div>',
          '<div class="track"><div class="bar"></div></div>',
          '<div class="status-line">',
          '<span class="upload-progress">0%</span>',
          '<span class="upload-size"></span>',
          '</div>',
        ].join('');

        item.querySelector('.upload-name').textContent = file.name;
        item.querySelector('.upload-state').textContent = 'Waiting';
        item.querySelector('.upload-size').textContent = formatBytes(file.size);
        queue.prepend(item);

        return item;
      }

      function hasFilePayload(event) {
        const types = Array.from((event.dataTransfer && event.dataTransfer.types) || []);
        return types.includes('Files');
      }

      function isAllowedFile(file) {
        const lowerName = file.name.toLowerCase();
        return file.type.startsWith('video/') || supportedExtensions.some((extension) => lowerName.endsWith(extension));
      }

      function setDragActive(active) {
        document.body.classList.toggle('drag-active', active);
      }

      function updateCard(card, state, progress, detail) {
        const safeProgress = Math.max(0, Math.min(100, progress));
        card.querySelector('.upload-state').textContent = state;
        card.querySelector('.bar').style.width = safeProgress + '%';
        card.querySelector('.upload-progress').textContent = safeProgress.toFixed(0) + '%';
        card.querySelector('.upload-size').textContent = detail;
      }

      async function postJson(path, payload) {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const text = await response.text();
        let parsed = {};

        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            parsed = { message: text };
          }
        }

        if (!response.ok) {
          throw new Error(parsed.message || 'Upload request failed');
        }

        return parsed;
      }

      async function postChunk(path, headers, blob) {
        const formData = new FormData();
        formData.append('file', blob, 'chunk.bin');

        const response = await fetch(path, {
          method: 'POST',
          headers,
          body: formData,
        });

        const text = await response.text();
        let parsed = {};

        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            parsed = { message: text };
          }
        }

        if (!response.ok) {
          throw new Error(parsed.message || 'Upload request failed');
        }

        return parsed;
      }

      async function uploadFile(file, card) {
        const init = await postJson('/upload/init', {
          fileName: file.name,
          totalSize: file.size,
          mimeType: file.type,
        });

        const uploadId = init.uploadId;
        const chunkSize = init.chunkSize || defaultChunkSize;
        const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
        let uploadedBytes = 0;
        const startedAt = performance.now();

        try {
          for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
            const start = chunkIndex * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunk = file.slice(start, end);

            updateCard(
              card,
              'Uploading',
              (uploadedBytes / file.size) * 100,
              formatBytes(uploadedBytes) + ' / ' + formatBytes(file.size),
            );

            await postChunk(
              '/upload/chunk',
              {
                'x-upload-id': uploadId,
                'x-chunk-index': String(chunkIndex),
                'x-total-chunks': String(totalChunks),
                'x-total-size': String(file.size),
              },
              chunk,
            );

            uploadedBytes = end;
            const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
            const speedBytesPerSecond = uploadedBytes / elapsedSeconds;
            updateCard(
              card,
              'Uploading',
              (uploadedBytes / file.size) * 100,
              formatBytes(uploadedBytes) + ' / ' + formatBytes(file.size),
            );
            updateBatchStatus(speedBytesPerSecond);
          }

          await postJson('/upload/complete', { uploadId });
          updateCard(card, 'Saved to phone', 100, formatBytes(file.size));
          updateBatchStatus(0);
        } catch (error) {
          await postJson('/upload/cancel', { uploadId }).catch(() => undefined);
          updateBatchStatus(0);
          throw error;
        }
      }

      async function handleSelection(fileList) {
        const files = Array.from(fileList || []);

        if (!files.length) {
          return;
        }

        const invalidFiles = files.filter((file) => !isAllowedFile(file));

        if (invalidFiles.length) {
          setPickerState('Only video files are allowed. Remove unsupported files and try again.');
          return;
        }

        pickButton.disabled = true;
        totalFilesInBatch = files.length;
        completedFilesInBatch = 0;
        updateBatchStatus(0);
        setPickerState('Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '...');

        for (const file of files) {
          const card = createUploadCard(file);

          try {
            await uploadFile(file, card);
            completedFilesInBatch += 1;
            updateBatchStatus(0);
          } catch (error) {
            updateCard(card, 'Upload failed', 0, error.message || 'Unknown error');
            updateBatchStatus(0);
          }
        }

        pickButton.disabled = false;
        fileInput.value = '';
        updateBatchStatus(0);
        setPickerState('Done. You can upload more videos.');
      }

      pickButton.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        handleSelection(fileInput.files).catch((error) => {
          pickButton.disabled = false;
          setPickerState(error.message || 'Upload failed.');
        });
      });

      window.addEventListener('dragenter', (event) => {
        if (!hasFilePayload(event)) {
          return;
        }

        event.preventDefault();
        dragDepth += 1;
        setDragActive(true);
        setPickerState('Drop videos anywhere to upload.');
      });

      window.addEventListener('dragover', (event) => {
        if (!hasFilePayload(event)) {
          return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      });

      window.addEventListener('dragleave', (event) => {
        if (!hasFilePayload(event)) {
          return;
        }

        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          setDragActive(false);
          setPickerState('Ready for new uploads.');
        }
      });

      window.addEventListener('drop', (event) => {
        if (!hasFilePayload(event)) {
          return;
        }

        event.preventDefault();
        dragDepth = 0;
        setDragActive(false);

        handleSelection((event.dataTransfer && event.dataTransfer.files) || []).catch((error) => {
          pickButton.disabled = false;
          setPickerState(error.message || 'Upload failed.');
        });
      });
    </script>
  </body>
</html>`;
}
