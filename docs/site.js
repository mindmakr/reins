// Interactive setup tabs and copy buttons for the reins documentation site.
(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];

  function selectTab(tab) {
    const target = tab.getAttribute('aria-controls');
    tabs.forEach((t) => {
      const active = t === tab;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach((p) => {
      p.classList.toggle('active', p.id === target);
    });
  }

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        selectTab(next);
      }
    });
  });

  document.querySelectorAll('button.copy').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select & copy';
      }
      setTimeout(() => {
        b.textContent = 'Copy';
      }, 1800);
    });
  });
})();
