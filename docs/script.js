/* ── script.js — Direct GitHub Sync Docs ── */

/* ── Navigation ──────────────────────────── */
(function () {
  const ham = document.querySelector('.nav-hamburger');
  const links = document.querySelector('.nav-links');
  if (ham && links) {
    ham.addEventListener('click', () => {
      links.classList.toggle('open');
    });
    // close on link click
    links.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => links.classList.remove('open'));
    });
  }

  // mark active nav link
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href').split('/').pop();
    if (href === path) a.classList.add('active');
  });
})();

/* ── Copy Code Buttons ───────────────────── */
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const block = btn.closest('.code-block');
    const text = block.querySelector('pre').textContent.trim();
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 2000);
    }).catch(() => {
      btn.textContent = 'Failed';
      setTimeout(() => btn.textContent = orig, 1500);
    });
  });
});

/* ── Error Accordion (Troubleshoot) ─────── */
document.querySelectorAll('.error-header').forEach(header => {
  header.addEventListener('click', () => {
    const item = header.closest('.error-item');
    const isOpen = item.classList.contains('open');
    // close all
    document.querySelectorAll('.error-item').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

/* ── Scroll-triggered fade-up ────────────── */
(function () {
  const els = document.querySelectorAll('.scroll-animate');
  if (!els.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('animate-up');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });

  els.forEach(el => observer.observe(el));
})();
