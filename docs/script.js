/* script.js — Direct GitHub Sync Documentation */

(function () {
  'use strict';

  // ── Active nav link ───────────────────────────
  function setActiveNav() {
    const currentPage = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav__links a, .nav__mobile-menu a').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      const linkPage = href.split('/').pop();
      a.classList.toggle('active', linkPage === currentPage);
    });
  }

  // ── Mobile menu toggle ────────────────────────
  function initMobileMenu() {
    const toggle = document.querySelector('.nav__menu-toggle');
    const menu = document.querySelector('.nav__mobile-menu');
    if (!toggle || !menu) return;

    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen);
    });

    document.addEventListener('click', e => {
      if (!toggle.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove('open');
      }
    });
  }

  // ── Scroll-triggered fade in ──────────────────
  function initFadeIn() {
    const targets = document.querySelectorAll('.fade-in, .flow-node');
    if (!targets.length) return;

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry, idx) => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const delay = el.dataset.delay || 0;
          setTimeout(() => el.classList.add('visible'), delay);
          io.unobserve(el);
        }
      });
    }, { threshold: 0.12 });

    targets.forEach((el, idx) => {
      if (!el.dataset.delay) el.dataset.delay = idx * 80;
      io.observe(el);
    });
  }

  // ── Accordion ─────────────────────────────────
  function initAccordion() {
    document.querySelectorAll('.accordion-trigger').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.accordion-item');
        const isOpen = item.classList.contains('open');

        document.querySelectorAll('.accordion-item.open').forEach(el => {
          el.classList.remove('open');
        });

        if (!isOpen) item.classList.add('open');
      });
    });
  }

  // ── Nav scroll style ──────────────────────────
  function initNavScroll() {
    const nav = document.querySelector('.nav');
    if (!nav) return;

    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 10);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ── Copy code buttons ─────────────────────────
  function initCopyCode() {
    document.querySelectorAll('pre').forEach(pre => {
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      btn.style.cssText = `
        position: absolute; top: 0.75rem; right: 0.75rem;
        background: var(--bg-hover); border: 1px solid var(--border);
        border-radius: var(--radius-sm); color: var(--text-muted);
        cursor: pointer; padding: 0.3rem;
        display: flex; align-items: center; justify-content: center;
        transition: all 200ms ease; opacity: 0;
      `;
      btn.querySelector('svg').style.cssText = 'width:14px;height:14px;';

      wrap.addEventListener('mouseenter', () => btn.style.opacity = '1');
      wrap.addEventListener('mouseleave', () => btn.style.opacity = '0');

      btn.addEventListener('click', () => {
        const text = pre.querySelector('code')?.innerText || pre.innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          btn.querySelector('svg').style.cssText = 'width:14px;height:14px;';
          setTimeout(() => {
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            btn.querySelector('svg').style.cssText = 'width:14px;height:14px;';
          }, 1800);
        });
      });

      wrap.appendChild(btn);
    });
  }

  // ── Smooth anchor scrolling ───────────────────
  function initSmoothAnchor() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // ── Init ──────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    setActiveNav();
    initMobileMenu();
    initFadeIn();
    initAccordion();
    initNavScroll();
    initCopyCode();
    initSmoothAnchor();
  });
})();
