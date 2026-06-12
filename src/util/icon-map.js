(function () {
  const icons = {
    php: {
      label: 'PHP',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 16c0-2.21 1.79-4 4-4s4 1.79 4 4"/><text x="7" y="11" font-size="7" font-weight="bold" fill="currentColor" stroke="none" font-family="sans-serif">php</text></svg>'
    },
    laravel: {
      label: 'Laravel',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l-2 4H6L4 4z"/><path d="M6 8l-1 4h3l-1 4h3l-1 4h8l1-4h-3l1-4h3l1-4H6z"/></svg>'
    },
    python: {
      label: 'Python',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-4 0-5 2-5 4v2h6v1H6c-2 0-4 1.5-4 5s2 5 4 5h2v-3c0-2 2-3 4-3h6c2 0 3-1 3-3V6c0-2-2-4-5-4h-5z"/><circle cx="9.5" cy="5.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="17.5" r="1" fill="currentColor" stroke="none"/></svg>'
    },
    node: {
      label: 'Node.js',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M12 12v6"/><path d="M8 14l4 2 4-2"/></svg>'
    },
    vite: {
      label: 'Vite',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
    },
    react: {
      label: 'React',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>'
    },
    vue: {
      label: 'Vue',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h4l6 10.5L18 3h4L12 21 2 3z"/><path d="M8.5 3L12 9.5 15.5 3"/></svg>'
    },
    angular: {
      label: 'Angular',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l9 4.5L21 3v3l-9 15L3 6V3z"/><path d="M12 7.5v9"/></svg>'
    },
    svelte: {
      label: 'Svelte',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 9c-1.5 0-3 .5-4 1.5-1-1-2.5-1.5-4-1.5-3 0-5.5 2.5-5.5 5.5S10.5 20.5 13.5 20.5c1.5 0 3-.5 4-1.5 1 1 2.5 1.5 4 1.5 3 0 5.5-2.5 5.5-5.5S22.5 9 19.5 9z" transform="translate(-1 0)"/><path d="M4.5 15C3 13.5 3 11 4.5 9.5" opacity="0.6"/></svg>'
    },
    docker: {
      label: 'Docker',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16c-1 0-2-.5-2-2 0-1 .5-1.5 1-2 .5.5 1.5 1 3 1h14c2.5 0 4-1 4-3.5S22 6.5 19.5 6.5c-.5 0-1 .1-1.5.3C17 4.5 15 3 12.5 3c-2 0-3.5 1-4.5 2.5-.5-.3-1-.5-1.5-.5-2.5 0-4.5 2-4.5 4.5 0 .3 0 .5.1.8C.7 10.8 0 11.5 0 12.5c0 2 1.5 3.5 3.5 3.5h.5z"/><rect x="6" y="10" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/><rect x="9" y="10" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/><rect x="12" y="10" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/><rect x="15" y="10" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/></svg>'
    },
    nginx: {
      label: 'Nginx',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4V4z"/><path d="M4 12h16"/><path d="M12 4v16"/><path d="M4 4l8 8"/><path d="M20 4l-8 8"/></svg>'
    },
    mysql: {
      label: 'MySQL',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>'
    },
    postgres: {
      label: 'PostgreSQL',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/><path d="M9 3v3"/><path d="M15 3v3"/></svg>'
    },
    mongodb: {
      label: 'MongoDB',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8 2 5 6 5 10c0 3 2 5 4 6v6h6v-6c2-1 4-3 4-6 0-4-3-8-7-8z"/><path d="M9 10c1-1 2-1 3 0"/><path d="M12 10c1-1 2-1 3 0"/></svg>'
    },
    redis: {
      label: 'Redis',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/></svg>'
    },
    ngrok: {
      label: 'ngrok',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="M8 6l4-4 4 4"/><circle cx="12" cy="14" r="4"/><path d="M12 18v4"/><path d="M8 22h8"/></svg>'
    },
    tailwind: {
      label: 'Tailwind CSS',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6c2 0 3 1 4 3 1 2 2 3 4 3 3 0 4-2 4-4s-1-3-3-3c-2 0-3 1-4 3-1 2-2 3-4 3-3 0-4-2-4-4s1-3 3-3z" transform="translate(0 4)"/></svg>'
    },
    composer: {
      label: 'Composer',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>'
    },
    npm: {
      label: 'npm',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 15V9h2v6H8z" fill="currentColor" stroke="none"/><path d="M14 15l3-6h-2l-1.5 3L12 9h-2l3 6"/></svg>'
    },
    yarn: {
      label: 'Yarn',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M7 22l5-7 5 7"/><path d="M12 15V9"/><path d="M9 12l3-3 3 3"/></svg>'
    },
    java: {
      label: 'Java',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 18c0 1 1 2 2 2h1v3c3 0 5-1 6-4l-3-1c0 1-1 2-2 2h-1v-2h3"/><path d="M15 11c-3 0-5 2-5 5s2 5 5 5 5-2 5-5-2-5-5-5z" opacity="0.4"/><text x="6" y="12" font-size="6" font-weight="bold" fill="currentColor" stroke="none" font-family="sans-serif">J</text></svg>'
    },
    ruby: {
      label: 'Ruby',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 7l8 15 8-15-8-5z"/><path d="M4 7l8 5 8-5"/><path d="M12 12v5"/></svg>'
    },
    go: {
      label: 'Go',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h12"/><path d="M3 12h8"/><circle cx="17" cy="14" r="3"/><path d="M20 14h3"/><text x="2" y="7" font-size="5" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="bold">Go</text></svg>'
    },
    rust: {
      label: 'Rust',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12a4 4 0 0 1 8 0"/><path d="M10 12a2 2 0 0 1 4 0"/></svg>'
    },
    dotnet: {
      label: '.NET',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><text x="6" y="15" font-size="8" font-weight="bold" fill="currentColor" stroke="none" font-family="sans-serif">.N</text></svg>'
    },
    graphql: {
      label: 'GraphQL',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z"/><path d="M12 2v20"/><path d="M4 6.5l8 4.5 8-4.5"/><circle cx="12" cy="11" r="2" fill="currentColor" stroke="none"/></svg>'
    },
    terminal: {
      label: 'Terminal',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 8l4 4-4 4"/><path d="M13 16h4"/></svg>'
    },
    generic: {
      label: 'Default',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2 2"/></svg>'
    }
  };

  function getIcon(key) {
    return icons[key] ? icons[key].svg : null;
  }

  function getAllIcons() {
    return Object.entries(icons).map(([key, val]) => ({ key, label: val.label, svg: val.svg }));
  }

  function getIconLabel(key) {
    return icons[key] ? icons[key].label : null;
  }

  window.iconMap = { getIcon, getAllIcons, getIconLabel };
})();
