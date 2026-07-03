// Report input focus events to the bridge via the service worker
(function() {
  let lastReport = 0

  document.addEventListener('focusin', (e) => {
    const el = e.target
    if (!el || !el.matches('input,textarea,[contenteditable="true"]')) return
    if (Date.now() - lastReport < 500) return
    lastReport = Date.now()

    const name = (el.name || el.id || '').toLowerCase()
    const placeholder = (el.placeholder || '').toLowerCase()
    const type = el.type || 'text'
    const ac = (el.autocomplete || '').toLowerCase()
    const isPassword = type === 'password' || ac.includes('password') || placeholder.includes('password')

    chrome.runtime.sendMessage({
      action: 'focusEvent',
      field: { tag: el.tagName, type, name, placeholder, autocomplete: ac, isPassword, valueLength: (el.value || '').length }
    })
  }, true)
})()
