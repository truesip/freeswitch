(function () {
  const baseInput = document.getElementById('baseUrl');
  const apiKeyInput = document.getElementById('apiKey');

  const uploadBtn = document.getElementById('uploadBtn');
  const uploadStatus = document.getElementById('uploadStatus');
  const uploadResult = document.getElementById('uploadResult');

  const refreshRecordingsBtn = document.getElementById('refreshRecordings');
  const listStatus = document.getElementById('listStatus');
  const recordingsBody = document.getElementById('recordingsBody');
  const recordingSelect = document.getElementById('recordingSelect');

  const callBtn = document.getElementById('callBtn');
  const callStatus = document.getElementById('callStatus');
  const callResult = document.getElementById('callResult');
  const toNumberInput = document.getElementById('toNumber');
  const fromNumberInput = document.getElementById('fromNumber');
  const audioUrlInput = document.getElementById('audioUrl');
  const audioTypeSelect = document.getElementById('audioType');

  function getBase() {
    const v = (baseInput.value || '').trim();
    if (v) return v.replace(/\/$/, '');
    return window.location.origin.replace(/\/$/, '');
  }

  function authHeaders() {
    const key = apiKeyInput.value.trim();
    return key ? { 'x-api-key': key } : {};
  }

  function setStatus(el, text, isError) {
    el.textContent = text || '';
    el.className = isError ? 'error' : text ? 'success' : '';
  }

  function safeJson(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return String(obj);
    }
  }

  async function uploadAudio() {
    const fileInput = document.getElementById('audioFile');
    const nameInput = document.getElementById('audioName');
    const file = fileInput.files[0];
    if (!file) {
      setStatus(uploadStatus, 'Please choose an audio file first.', true);
      return;
    }

    const fd = new FormData();
    fd.append('file', file);
    const name = nameInput.value.trim();
    if (name) fd.append('name', name);

    uploadResult.textContent = '';
    setStatus(uploadStatus, 'Uploading...', false);

    try {
      const res = await fetch(getBase() + '/api/audio/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(uploadStatus, 'Upload failed: ' + (data.error || res.statusText), true);
      } else {
        setStatus(uploadStatus, 'Upload successful.', false);
        uploadResult.textContent = safeJson(data);
        if (data.playbackUri) {
          audioUrlInput.value = data.playbackUri;
        }
        await loadRecordings();
      }
    } catch (err) {
      console.error(err);
      setStatus(uploadStatus, 'Upload error: ' + err.message, true);
    }
  }

  async function loadRecordings() {
    listStatus.textContent = 'Loading...';
    recordingsBody.innerHTML = '';
    recordingSelect.innerHTML = '<option value="">-- none --</option>';

    try {
      const res = await fetch(getBase() + '/api/audio', {
        method: 'GET',
        headers: authHeaders(),
      });
      const list = await res.json().catch(() => []);

      if (!res.ok) {
        setStatus(listStatus, 'Error loading recordings: ' + (list.error || res.statusText), true);
        return;
      }

      setStatus(listStatus, 'Loaded ' + list.length + ' recordings.', false);

      (list || []).forEach(function (item) {
        const name = item.name || item.recordingName || item.id || '';
        const playbackUri =
          item.playbackUri ||
          item.playback_url ||
          (name ? 'recording:' + name : '');
        if (!name || !playbackUri) return;

        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = name;
        tr.appendChild(tdName);

        const tdUri = document.createElement('td');
        tdUri.textContent = playbackUri;
        tr.appendChild(tdUri);

        const tdActions = document.createElement('td');
        const useBtn = document.createElement('button');
        useBtn.textContent = 'Use for call';
        useBtn.onclick = function () {
          audioUrlInput.value = playbackUri;
        };

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.style.marginLeft = '0.5rem';
        delBtn.onclick = async function () {
          if (!confirm('Delete recording ' + name + '?')) return;
          try {
            const r = await fetch(getBase() + '/api/audio/' + encodeURIComponent(name), {
              method: 'DELETE',
              headers: authHeaders(),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              alert('Delete failed: ' + (d.error || r.statusText));
            } else {
              await loadRecordings();
            }
          } catch (e) {
            alert('Delete error: ' + e.message);
          }
        };

        tdActions.appendChild(useBtn);
        tdActions.appendChild(delBtn);
        tr.appendChild(tdActions);

        recordingsBody.appendChild(tr);

        const opt = document.createElement('option');
        opt.value = playbackUri;
        opt.textContent = name + ' (' + playbackUri + ')';
        recordingSelect.appendChild(opt);
      });
    } catch (err) {
      console.error(err);
      setStatus(listStatus, 'Error loading recordings: ' + err.message, true);
    }
  }

  recordingSelect.addEventListener('change', function () {
    if (this.value) {
      audioUrlInput.value = this.value;
      audioTypeSelect.value = 'raw';
    }
  });

  function buildAudioUrl() {
    const raw = audioUrlInput.value.trim();
    const type = audioTypeSelect.value;
    if (!raw) return '';
    if (type === 'custom') {
      if (raw.startsWith('sound:')) return raw;
      const path = raw.replace(/^sound:/, '');
      return 'sound:' + path;
    }
    if (type === 'ari') {
      if (raw.startsWith('recording:')) return raw;
      const name = raw.replace(/^recording:/, '');
      return 'recording:' + name;
    }
    // raw
    return raw;
  }

  async function placeCall() {
    const toNumber = toNumberInput.value.trim();
    const fromNumber = fromNumberInput.value.trim();
    const audioUrl = buildAudioUrl();

    if (!toNumber || !fromNumber || !audioUrl) {
      setStatus(callStatus, 'toNumber, fromNumber, and audioUrl are required.', true);
      return;
    }

    const payload = { toNumber: toNumber, fromNumber: fromNumber, audioUrl: audioUrl };

    callResult.textContent = '';
    setStatus(callStatus, 'Placing call...', false);

    try {
      const res = await fetch(getBase() + '/call', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(callStatus, 'Call failed: ' + (data.error || data.detail || res.statusText), true);
      } else {
        setStatus(callStatus, 'Call placed.', false);
        callResult.textContent = safeJson(data);
      }
    } catch (err) {
      console.error(err);
      setStatus(callStatus, 'Call error: ' + err.message, true);
    }
  }

  uploadBtn.addEventListener('click', function (e) {
    e.preventDefault();
    uploadAudio();
  });

  refreshRecordingsBtn.addEventListener('click', function (e) {
    e.preventDefault();
    loadRecordings();
  });

  callBtn.addEventListener('click', function (e) {
    e.preventDefault();
    placeCall();
  });

  // Initialize base URL to current origin for convenience
  baseInput.value = window.location.origin.replace(/\/$/, '');
})();
