const $ = (id) => document.getElementById(id);
const fields = ['host', 'port', 'path', 'auth'];

chrome.storage.local.get(fields).then((cfg) => {
  for (const f of fields) $(f).value = cfg[f] ?? '';
});

 $('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    host: $('host').value.trim(),
    port: Number($('port').value) || 80,
    path: $('path').value.trim() || '/audio.cgi',
    auth: $('auth').value.trim()
  });
  const saved = $('saved');
  saved.style.visibility = 'visible';
  setTimeout(() => (saved.style.visibility = 'hidden'), 1500);
});
