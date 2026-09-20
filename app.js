const TEN_MB = 10 * 1024 * 1024;

const state = {
  rootHandle: null,
  rootName: "",
  files: [],
  scannedFiles: 0,
  movedFiles: 0,
  isBusy: false,
};

const els = {
  chooseFolder: document.querySelector("#chooseFolder"),
  rescanFolder: document.querySelector("#rescanFolder"),
  moveSelected: document.querySelector("#moveSelected"),
  folderLabel: document.querySelector("#folderLabel"),
  targetFolderName: document.querySelector("#targetFolderName"),
  limitMb: document.querySelector("#limitMb"),
  fileFilter: document.querySelector("#fileFilter"),
  selectAll: document.querySelector("#selectAll"),
  statusMessage: document.querySelector("#statusMessage"),
  tableWrap: document.querySelector(".table-wrap"),
  filesBody: document.querySelector("#filesBody"),
  rowTemplate: document.querySelector("#fileRowTemplate"),
};

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function getLimitBytes() {
  const mb = Number.parseFloat(els.limitMb.value);
  if (!Number.isFinite(mb) || mb <= 0) return TEN_MB;
  return mb * 1024 * 1024;
}

function sanitizeFolderName(value) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\.+$/g, "") || "Under 10MB";
}

function setBusy(isBusy, message = "") {
  state.isBusy = isBusy;
  els.chooseFolder.disabled = isBusy;
  els.rescanFolder.disabled = isBusy || !state.rootHandle;
  els.moveSelected.disabled = isBusy || getSelectedFiles().length === 0;
  els.targetFolderName.disabled = isBusy;
  els.limitMb.disabled = isBusy;
  els.fileFilter.disabled = isBusy;
  els.selectAll.disabled = isBusy || state.files.length === 0;
  if (message) {
    els.statusMessage.textContent = message;
    els.statusMessage.classList.toggle("busy", isBusy);
  }
}

function showStatus(message, type = "") {
  els.statusMessage.textContent = message;
  els.statusMessage.className = `status-message ${type}`.trim();
  els.statusMessage.hidden = false;
  els.tableWrap.hidden = true;
}

function showTable() {
  els.statusMessage.hidden = true;
  els.tableWrap.hidden = false;
}

function getSelectedFiles() {
  return state.files.filter((file) => file.selected && !file.moved && !file.error);
}

function updateSummary() {
  const selected = getSelectedFiles();

  els.moveSelected.disabled = state.isBusy || selected.length === 0;
  els.selectAll.disabled = state.isBusy || state.files.length === 0;

  const available = state.files.filter((file) => !file.moved && !file.error);
  els.selectAll.checked = available.length > 0 && available.every((file) => file.selected);
  els.selectAll.indeterminate = available.some((file) => file.selected) && !els.selectAll.checked;
}

function renderRows() {
  const filter = els.fileFilter.value.trim().toLowerCase();
  const visibleFiles = state.files.filter((file) => file.relativePath.toLowerCase().includes(filter));

  els.filesBody.replaceChildren();

  for (const file of visibleFiles) {
    const row = els.rowTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = row.querySelector(".row-check");
    const pathCell = row.querySelector(".path-cell");
    const sizeCell = row.querySelector(".size-cell");
    const modifiedCell = row.querySelector(".modified-cell");
    const pill = row.querySelector(".pill");

    checkbox.checked = file.selected;
    checkbox.disabled = state.isBusy || file.moved || file.error;
    checkbox.addEventListener("change", () => {
      file.selected = checkbox.checked;
      updateSummary();
    });

    pathCell.textContent = file.relativePath;
    sizeCell.textContent = formatBytes(file.size);
    modifiedCell.textContent = formatDate(file.lastModified);
    pill.textContent = file.status;
    pill.className = `pill ${file.statusClass || ""}`.trim();

    els.filesBody.append(row);
  }

  if (state.files.length === 0) {
    showStatus(`No files below ${els.limitMb.value || 10} MB were found.`);
  } else if (visibleFiles.length === 0) {
    showStatus("No matching paths.");
  } else {
    showTable();
  }

  updateSummary();
}

async function ensurePermission(handle, mode) {
  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function scanDirectory(directoryHandle, pathSegments, matches, targetFolderName, limitBytes) {
  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "directory") {
      if (pathSegments.length === 0 && entry.name === targetFolderName) continue;
      await scanDirectory(entry, [...pathSegments, entry.name], matches, targetFolderName, limitBytes);
      continue;
    }

    state.scannedFiles += 1;
    const file = await entry.getFile();
    if (file.size < limitBytes) {
      const relativeSegments = [...pathSegments, entry.name];
      matches.push({
        id: crypto.randomUUID(),
        name: entry.name,
        relativePath: relativeSegments.join("/"),
        parentPath: pathSegments,
        parentHandle: directoryHandle,
        fileHandle: entry,
        size: file.size,
        lastModified: file.lastModified,
        selected: true,
        moved: false,
        error: false,
        status: "Ready",
        statusClass: "",
      });
    }
  }
}

async function scanRoot() {
  if (!state.rootHandle) return;
  setBusy(true);

  try {
    const canRead = await ensurePermission(state.rootHandle, "read");
    if (!canRead) {
      showStatus("Folder permission was not granted.", "error");
      return;
    }

    const targetFolderName = sanitizeFolderName(els.targetFolderName.value);
    els.targetFolderName.value = targetFolderName;
    state.files = [];
    state.scannedFiles = 0;
    state.movedFiles = 0;

    await scanDirectory(state.rootHandle, [], state.files, targetFolderName, getLimitBytes());
    state.files.sort((a, b) => a.size - b.size || a.relativePath.localeCompare(b.relativePath));
    renderRows();
  } catch (error) {
    showStatus(error.message || "The folder could not be scanned.", "error");
  } finally {
    setBusy(false);
    updateSummary();
  }
}

async function getOrCreateDirectoryPath(rootHandle, segments) {
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function fileExists(directoryHandle, fileName) {
  try {
    await directoryHandle.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

async function getAvailableFileName(directoryHandle, fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  let candidate = fileName;
  let counter = 1;

  while (await fileExists(directoryHandle, candidate)) {
    candidate = `${stem} (${counter})${extension}`;
    counter += 1;
  }

  return candidate;
}

async function moveFileToTarget(fileRecord, targetFolderName) {
  const destinationPath = [targetFolderName, ...fileRecord.parentPath];
  const destinationDirectory = await getOrCreateDirectoryPath(state.rootHandle, destinationPath);
  const destinationName = await getAvailableFileName(destinationDirectory, fileRecord.name);
  const destinationHandle = await destinationDirectory.getFileHandle(destinationName, { create: true });
  const writable = await destinationHandle.createWritable();

  try {
    const sourceFile = await fileRecord.fileHandle.getFile();
    await writable.write(sourceFile);
  } finally {
    await writable.close();
  }

  await fileRecord.parentHandle.removeEntry(fileRecord.name);
  fileRecord.moved = true;
  fileRecord.selected = false;
  fileRecord.status = destinationName === fileRecord.name ? "Moved" : "Renamed";
  fileRecord.statusClass = "done";
}

async function moveSelectedFiles() {
  const selected = getSelectedFiles();
  if (selected.length === 0) return;

  setBusy(true, `Moving 0 of ${selected.length} files...`);

  try {
    const canWrite = await ensurePermission(state.rootHandle, "readwrite");
    if (!canWrite) {
      showStatus("Write permission was not granted.", "error");
      return;
    }

    const targetFolderName = sanitizeFolderName(els.targetFolderName.value);
    els.targetFolderName.value = targetFolderName;

    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      file.status = "Moving";
      file.statusClass = "skipped";
      renderRows();
      setBusy(true, `Moving ${index + 1} of ${selected.length} files...`);

      try {
        await moveFileToTarget(file, targetFolderName);
        state.movedFiles += 1;
      } catch (error) {
        file.error = true;
        file.status = "Error";
        file.statusClass = "error";
        file.errorMessage = error.message;
      }
    }

    renderRows();
    const failed = selected.filter((file) => file.error).length;
    if (failed > 0) {
      showStatus(`${state.movedFiles} moved, ${failed} failed. Rescan to refresh the list.`, "error");
    } else {
      showStatus(`${state.movedFiles} files moved into "${targetFolderName}".`);
    }
  } finally {
    setBusy(false);
    updateSummary();
  }
}

async function chooseFolder() {
  if (!("showDirectoryPicker" in window)) {
    showStatus("This browser does not support folder access. Use current Chrome or Edge.", "error");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({
      id: "folder-size-separator",
      mode: "readwrite",
    });

    state.rootHandle = handle;
    state.rootName = handle.name;
    els.folderLabel.textContent = handle.name;
    await scanRoot();
  } catch (error) {
    if (error.name !== "AbortError") {
      showStatus(error.message || "The folder could not be opened.", "error");
    }
  }
}

els.chooseFolder.addEventListener("click", chooseFolder);
els.rescanFolder.addEventListener("click", scanRoot);
els.moveSelected.addEventListener("click", moveSelectedFiles);
els.fileFilter.addEventListener("input", renderRows);
els.limitMb.addEventListener("change", () => {
  if (state.rootHandle) scanRoot();
});
els.targetFolderName.addEventListener("change", () => {
  els.targetFolderName.value = sanitizeFolderName(els.targetFolderName.value);
});
els.selectAll.addEventListener("change", () => {
  for (const file of state.files) {
    if (!file.moved && !file.error) file.selected = els.selectAll.checked;
  }
  renderRows();
});

updateSummary();
