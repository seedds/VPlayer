type UploadPageOptions = {
  chunkSize: number;
};

export function buildUploadPage({ chunkSize }: UploadPageOptions): string {
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
        max-width: 980px;
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 60px rgba(38, 25, 16, 0.08);
        backdrop-filter: blur(14px);
        padding: 22px;
      }

      .panel h2 {
        margin: 0 0 10px;
        font-size: 20px;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .toolbar,
      .library-toolbar {
        margin-top: 18px;
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }

      .library-toolbar {
        justify-content: space-between;
      }

      .library-toolbar-actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-left: auto;
      }

      .button,
      .ghost-button,
      .danger-button,
      .path-button {
        border: 0;
        border-radius: 16px;
        padding: 12px 16px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      .button {
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        color: white;
        box-shadow: 0 18px 32px rgba(155, 73, 39, 0.24);
      }

      .ghost-button,
      .path-button {
        background: rgba(255, 255, 255, 0.74);
        color: var(--ink);
        border: 1px solid var(--line);
      }

      .back-button {
        min-width: 48px;
        padding: 12px;
        font-size: 20px;
        line-height: 1;
      }

      .danger-button {
        background: rgba(158, 62, 40, 0.12);
        color: #9e3e28;
        border: 1px solid rgba(158, 62, 40, 0.14);
      }

      .button:disabled,
      .ghost-button:disabled,
      .danger-button:disabled {
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

      .queue,
      .library-list {
        display: grid;
        gap: 12px;
        margin-top: 16px;
      }

      .upload-item,
      .library-item {
        padding: 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid var(--line);
      }

      .upload-row,
      .status-line,
      .library-row,
      .library-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .library-row {
        align-items: center;
      }

      .upload-name,
      .library-name {
        font-weight: 700;
        font-size: 15px;
        color: var(--ink);
      }

      .open-folder {
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        text-align: left;
      }

      .upload-state,
      .library-kind,
      .library-date,
      .empty,
      .breadcrumbs {
        color: var(--muted);
        font-size: 13px;
      }

      .library-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
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

      .status-line,
      .library-meta {
        margin-top: 10px;
        align-items: center;
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

      .breadcrumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
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
        .status-line,
        .library-row,
        .library-meta {
          flex-direction: column;
          align-items: flex-start;
        }

        .library-actions {
          justify-content: flex-start;
        }

        .library-toolbar-actions {
          width: 100%;
          margin-left: 0;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h2>Library folders</h2>
        <p>Create folders, remove folders, and remove files from your computer. Uploaded files are saved into the folder you are currently viewing.</p>
        <div class="library-toolbar">
          <button aria-label="Go back" class="ghost-button back-button" hidden id="up-button" type="button">&#8592;</button>
          <div class="library-toolbar-actions">
            <button class="ghost-button" id="refresh-button" type="button">Refresh</button>
            <button class="button" id="new-folder-button" type="button">New folder</button>
          </div>
        </div>
        <div class="breadcrumbs" id="breadcrumbs" style="margin-top: 16px;"></div>
        <div class="library-list" id="library-list">
          <div class="empty">Loading library...</div>
        </div>
      </section>

      <section class="panel">
        <h2>Upload files</h2>
        <p>Keep this page open until uploads reach 100%. Files are saved into the current folder shown above. You can also drag files or folders anywhere onto this page.</p>
        <div class="toolbar">
          <button class="button" id="pick-button" type="button">Choose files</button>
          <button class="ghost-button" id="pick-folder-button" type="button">Choose folder</button>
          <span class="empty" id="picker-state">Ready for new uploads.</span>
        </div>
        <div class="batch-status" id="batch-status">
          <span><strong id="batch-progress">0/0</strong> files completed</span>
          <span>Speed <strong id="batch-speed">Idle</strong></span>
        </div>
        <input id="file-input" type="file" multiple hidden />
        <input id="folder-input" type="file" webkitdirectory directory multiple hidden />
        <div class="queue" id="queue">
          <div class="empty">No uploads yet.</div>
        </div>
      </section>
    </main>

    <div class="drop-overlay" id="drop-overlay" aria-hidden="true">
      <div class="drop-overlay-content">
        <div class="drop-overlay-title">Drop files or folders</div>
        <div class="drop-overlay-copy">Release anywhere on this page and the upload starts immediately.</div>
      </div>
    </div>

    <script>
      const pickButton = document.getElementById('pick-button');
      const pickFolderButton = document.getElementById('pick-folder-button');
      const fileInput = document.getElementById('file-input');
      const folderInput = document.getElementById('folder-input');
      const queue = document.getElementById('queue');
      const pickerState = document.getElementById('picker-state');
      const batchProgress = document.getElementById('batch-progress');
      const batchSpeed = document.getElementById('batch-speed');
      const libraryList = document.getElementById('library-list');
      const breadcrumbs = document.getElementById('breadcrumbs');
      const upButton = document.getElementById('up-button');
      const refreshButton = document.getElementById('refresh-button');
      const newFolderButton = document.getElementById('new-folder-button');
      const defaultChunkSize = ${chunkSize};
      let currentPath = '';
      let dragDepth = 0;
      let totalFilesInBatch = 0;
      let completedFilesInBatch = 0;

      function setPickerState(text) {
        pickerState.textContent = text;
      }

      function splitPath(path) {
        return (path || '').split('/').filter(Boolean);
      }

      function joinPath(basePath, childPath) {
        return splitPath([basePath, childPath].filter(Boolean).join('/')).join('/');
      }

      function getParentPath(path) {
        const segments = splitPath(path);
        return segments.length > 1 ? segments.slice(0, -1).join('/') : '';
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

      function formatDate(timestamp) {
        if (!timestamp) {
          return '';
        }

        return new Date(timestamp).toLocaleString();
      }

      function updateBatchStatus(speedBytesPerSecond) {
        batchProgress.textContent = completedFilesInBatch + '/' + totalFilesInBatch;
        batchSpeed.textContent = formatSpeed(speedBytesPerSecond);
      }

      function createUploadCard(file, relativePath) {
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

        item.querySelector('.upload-name').textContent = relativePath;
        item.querySelector('.upload-state').textContent = 'Waiting';
        item.querySelector('.upload-size').textContent = formatBytes(file.size);
        queue.prepend(item);

        return item;
      }

      function updateCard(card, state, progress, detail) {
        const safeProgress = Math.max(0, Math.min(100, progress));
        card.querySelector('.upload-state').textContent = state;
        card.querySelector('.bar').style.width = safeProgress + '%';
        card.querySelector('.upload-progress').textContent = safeProgress.toFixed(0) + '%';
        card.querySelector('.upload-size').textContent = detail;
      }

      function hasFilePayload(event) {
        const types = Array.from((event.dataTransfer && event.dataTransfer.types) || []);
        return types.includes('Files');
      }

      function setDragActive(active) {
        document.body.classList.toggle('drag-active', active);
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
          throw new Error(parsed.message || 'Request failed');
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

      function renderBreadcrumbs() {
        breadcrumbs.innerHTML = '';
        let accumulatedPath = '';
        const segments = splitPath(currentPath);

        segments.forEach((segment, index) => {
          if (index > 0) {
            const separator = document.createElement('span');
            separator.textContent = '/';
            breadcrumbs.append(separator);
          }

          accumulatedPath = joinPath(accumulatedPath, segment);
          const button = document.createElement('button');
          button.className = 'path-button';
          button.type = 'button';
          button.textContent = segment;
          button.addEventListener('click', () => {
            loadLibrary(accumulatedPath).catch((error) => setPickerState(error.message || 'Unable to load library.'));
          });
          breadcrumbs.append(button);
        });

        upButton.hidden = !currentPath;
        breadcrumbs.hidden = segments.length === 0;
      }

      function describeLibraryItem(item) {
        if (item.kind === 'folder') {
          return 'Folder';
        }

        if (item.kind === 'video') {
          return 'Video · ' + formatBytes(item.size);
        }

        if (item.kind === 'subtitle') {
          return 'Subtitle · ' + formatBytes(item.size);
        }

        return 'File · ' + formatBytes(item.size);
      }

      function renderLibrary(items) {
        libraryList.innerHTML = '';

        if (!items.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'This folder is empty.';
          libraryList.append(empty);
          return;
        }

        for (const item of items) {
          const row = document.createElement('div');
          row.className = 'library-item';

          const top = document.createElement('div');
          top.className = 'library-row';

          const title = item.kind === 'folder' ? document.createElement('button') : document.createElement('div');
          title.className = item.kind === 'folder' ? 'library-name open-folder' : 'library-name';
          title.textContent = item.name;

          if (item.kind === 'folder') {
            title.type = 'button';
            title.addEventListener('click', () => {
              loadLibrary(item.relativePath).catch((error) => setPickerState(error.message || 'Unable to open folder.'));
            });
          }

          const actions = document.createElement('div');
          actions.className = 'library-actions';

          if (item.kind === 'folder') {
            const openButton = document.createElement('button');
            openButton.className = 'ghost-button';
            openButton.type = 'button';
            openButton.textContent = 'Open';
            openButton.addEventListener('click', () => {
              loadLibrary(item.relativePath).catch((error) => setPickerState(error.message || 'Unable to open folder.'));
            });
            actions.append(openButton);
          }

          const deleteButton = document.createElement('button');
          deleteButton.className = 'danger-button';
          deleteButton.type = 'button';
          deleteButton.textContent = 'Delete';
          deleteButton.addEventListener('click', async () => {
            const label = item.kind === 'folder' ? 'folder' : 'file';
            const confirmed = window.confirm('Delete this ' + label + '?\n\n' + item.relativePath);

            if (!confirmed) {
              return;
            }

            try {
              await postJson('/library/delete', {
                relativePath: item.relativePath,
                entryType: item.kind === 'folder' ? 'folder' : 'file',
              });
              await loadLibrary(currentPath);
            } catch (error) {
              setPickerState(error.message || 'Delete failed.');
            }
          });
          actions.append(deleteButton);

          top.append(title, actions);

          const meta = document.createElement('div');
          meta.className = 'library-meta';
          const kind = document.createElement('span');
          kind.className = 'library-kind';
          kind.textContent = describeLibraryItem(item);
          const date = document.createElement('span');
          date.className = 'library-date';
          date.textContent = formatDate(item.modified);
          meta.append(kind, date);

          row.append(top, meta);
          libraryList.append(row);
        }
      }

      async function loadLibrary(path) {
        const response = await postJson('/library/list', { path: path || '' });
        currentPath = response.path || '';
        renderBreadcrumbs();
        renderLibrary(response.items || []);
      }

      async function uploadFile(fileSpec, card) {
        const init = await postJson('/upload/init', {
          fileName: fileSpec.file.name,
          relativePath: fileSpec.relativePath,
          totalSize: fileSpec.file.size,
          mimeType: fileSpec.file.type,
        });

        const uploadId = init.uploadId;
        const savedRelativePath = init.relativePath || fileSpec.relativePath;
        const chunkSize = init.chunkSize || defaultChunkSize;
        const totalChunks = Math.max(1, Math.ceil(fileSpec.file.size / chunkSize));
        let uploadedBytes = 0;
        const startedAt = performance.now();

        card.querySelector('.upload-name').textContent = savedRelativePath;

        try {
          for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
            const start = chunkIndex * chunkSize;
            const end = Math.min(fileSpec.file.size, start + chunkSize);
            const chunk = fileSpec.file.slice(start, end);

            updateCard(
              card,
              'Uploading',
              fileSpec.file.size > 0 ? (uploadedBytes / fileSpec.file.size) * 100 : 0,
              formatBytes(uploadedBytes) + ' / ' + formatBytes(fileSpec.file.size),
            );

            await postChunk(
              '/upload/chunk',
              {
                'x-upload-id': String(uploadId),
                'x-chunk-index': String(chunkIndex),
                'x-total-chunks': String(totalChunks),
                'x-total-size': String(fileSpec.file.size),
              },
              chunk,
            );

            uploadedBytes = end;
            const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
            const speedBytesPerSecond = uploadedBytes / elapsedSeconds;
            updateCard(
              card,
              'Uploading',
              fileSpec.file.size > 0 ? (uploadedBytes / fileSpec.file.size) * 100 : 100,
              formatBytes(uploadedBytes) + ' / ' + formatBytes(fileSpec.file.size),
            );
            updateBatchStatus(speedBytesPerSecond);
          }

          await postJson('/upload/complete', { uploadId });
          updateCard(card, 'Saved to phone', 100, savedRelativePath === fileSpec.relativePath ? formatBytes(fileSpec.file.size) : 'Saved as ' + savedRelativePath);
          updateBatchStatus(0);
        } catch (error) {
          await postJson('/upload/cancel', { uploadId }).catch(() => undefined);
          updateBatchStatus(0);
          throw error;
        }
      }

      async function handleSelection(fileSpecs) {
        const files = Array.from(fileSpecs || []);

        if (!files.length) {
          return;
        }

        pickButton.disabled = true;
        pickFolderButton.disabled = true;
        totalFilesInBatch = files.length;
        completedFilesInBatch = 0;
        updateBatchStatus(0);
        setPickerState('Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '...');

        for (const fileSpec of files) {
          const card = createUploadCard(fileSpec.file, fileSpec.relativePath);

          try {
            await uploadFile(fileSpec, card);
            completedFilesInBatch += 1;
            updateBatchStatus(0);
          } catch (error) {
            updateCard(card, 'Upload failed', 0, error.message || 'Unknown error');
            updateBatchStatus(0);
          }
        }

        pickButton.disabled = false;
        pickFolderButton.disabled = false;
        fileInput.value = '';
        folderInput.value = '';
        updateBatchStatus(0);
        setPickerState('Done. You can upload more files.');
        await loadLibrary(currentPath);
      }

      function toFileSpec(file, relativePath) {
        return {
          file,
          relativePath: joinPath(currentPath, relativePath || file.webkitRelativePath || file.name),
        };
      }

      async function readAllDirectoryEntries(reader) {
        const entries = [];

        while (true) {
          const batch = await new Promise((resolve, reject) => {
            reader.readEntries(resolve, reject);
          });

          if (!batch.length) {
            return entries;
          }

          entries.push(...batch);
        }
      }

      async function walkEntry(entry, parentPath) {
        const relativePath = joinPath(parentPath, entry.name);

        if (entry.isFile) {
          return await new Promise((resolve, reject) => {
            entry.file(
              (file) => resolve([toFileSpec(file, relativePath)]),
              reject,
            );
          });
        }

        if (!entry.isDirectory) {
          return [];
        }

        const entries = await readAllDirectoryEntries(entry.createReader());
        const nested = await Promise.all(entries.map((child) => walkEntry(child, relativePath)));
        return nested.flat();
      }

      async function collectDroppedFiles(dataTransfer) {
        const items = Array.from((dataTransfer && dataTransfer.items) || []);
        const entryItems = items
          .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
          .filter(Boolean);

        if (entryItems.length > 0) {
          const nestedFiles = (await Promise.all(entryItems.map((entry) => walkEntry(entry, '')))).flat();

          if (nestedFiles.length > 0) {
            return nestedFiles;
          }
        }

        return Array.from((dataTransfer && dataTransfer.files) || []).map((file) => toFileSpec(file, file.webkitRelativePath || file.name));
      }

      pickButton.addEventListener('click', () => fileInput.click());
      pickFolderButton.addEventListener('click', () => folderInput.click());
      refreshButton.addEventListener('click', () => {
        loadLibrary(currentPath).catch((error) => setPickerState(error.message || 'Unable to load library.'));
      });
      upButton.addEventListener('click', () => {
        loadLibrary(getParentPath(currentPath)).catch((error) => setPickerState(error.message || 'Unable to load library.'));
      });
      newFolderButton.addEventListener('click', async () => {
        const name = window.prompt('Folder name');

        if (!name) {
          return;
        }

        try {
          await postJson('/library/folder', {
            parentPath: currentPath,
            name,
          });
          await loadLibrary(currentPath);
        } catch (error) {
          setPickerState(error.message || 'Unable to create folder.');
        }
      });
      fileInput.addEventListener('change', () => {
        const fileSpecs = Array.from(fileInput.files || []).map((file) => toFileSpec(file, file.name));
        handleSelection(fileSpecs).catch((error) => {
          pickButton.disabled = false;
          pickFolderButton.disabled = false;
          setPickerState(error.message || 'Upload failed.');
        });
      });
      folderInput.addEventListener('change', () => {
        const fileSpecs = Array.from(folderInput.files || []).map((file) => toFileSpec(file, file.webkitRelativePath || file.name));
        handleSelection(fileSpecs).catch((error) => {
          pickButton.disabled = false;
          pickFolderButton.disabled = false;
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
        setPickerState('Drop files or folders anywhere to upload.');
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

        collectDroppedFiles(event.dataTransfer)
          .then((fileSpecs) => handleSelection(fileSpecs))
          .catch((error) => {
            pickButton.disabled = false;
            pickFolderButton.disabled = false;
            setPickerState(error.message || 'Upload failed.');
          });
      });

      loadLibrary('').catch((error) => {
        setPickerState(error.message || 'Unable to load library.');
      });
    </script>
  </body>
</html>`;
}
