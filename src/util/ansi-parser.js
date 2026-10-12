function ansiToHtml(text) {
  if (!text) return '';

  // Escape structural HTML sequences to guarantee text layouts won't break
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Render text system status log boundaries cleanly
  formatted = formatted.replace(/\[system\] (.*)/g, '<span class="t-blue">[system] $1</span>');
  formatted = formatted.replace(/\[error\] (.*)/g, '<span class="t-error">[error] $1</span>');
  formatted = formatted.replace(/\[info\] (.*)/g, '<span class="t-gray">[info] $1</span>');

  // Highlight the log level of plain (uncoloured) lines: "ERROR:", "[12:00] WARNING", "local.ERROR:"
  if (!formatted.includes('\x1B[')) {
    formatted = formatted.replace(
      /^(\s*(?:\[[^\]]*\]\s*)?(?:[\w-]+\.)?)(ERROR|FATAL|CRITICAL|WARN(?:ING)?)\b/,
      (m, lead, level) => `${lead}<span class="${level.startsWith('WARN') ? 'lvl-warn' : 'lvl-error'}">${level}</span>`
    );
  }

  // Clear out non-color related terminal screen positions
  formatted = formatted.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, (match) => {
    if (match.endsWith('m')) return match;
    return '';
  });

  // ANSI SGR codes mapped onto the design tokens
  const colorMap = {
    '1': 'font-weight: bold;',
    '2': 'color: var(--ansi-dim);',
    '22': 'font-weight: normal; color: var(--slate12);',

    // Foreground Text styles mapping
    '30': 'color: var(--ansi-black);',
    '31': 'color: var(--ruby11);',
    '32': 'color: var(--jade9);',
    '33': 'color: var(--amber9);',
    '34': 'color: var(--ansi-blue);',
    '35': 'color: var(--ansi-purple);',
    '36': 'color: var(--ansi-cyan);',
    '37': 'color: var(--slate12);',
    '39': 'color: inherit;',

    // Background colours become bold coloured text, so badges don't bleed full-width
    '40': 'background-color: transparent;',
    '41': 'color: var(--ruby11); font-weight: bold;',
    '42': 'color: var(--jade9); font-weight: bold;',
    '43': 'color: var(--amber9); font-weight: bold;',
    '44': 'color: var(--ansi-blue); font-weight: bold;',
    '45': 'color: var(--ansi-purple); font-weight: bold;',
    '46': 'color: var(--ansi-cyan); font-weight: bold;',
    '47': 'color: var(--slate12); font-weight: bold;',
    '49': 'background-color: transparent; color: inherit;'
  };

  let openSpansCount = 0;
  const ansiColorRegex = /\x1B\[([0-9;]*)m/g;

  formatted = formatted.replace(ansiColorRegex, (match, codeString) => {
    if (codeString === '0' || codeString === '') {
      let closingTags = '';
      while (openSpansCount > 0) {
        closingTags += '</span>';
        openSpansCount--;
      }
      return closingTags;
    }

    const individualCodes = codeString.split(';');
    let compiledStyles = '';

    individualCodes.forEach(code => {
      if (colorMap[code]) {
        compiledStyles += colorMap[code];
      }
    });

    if (compiledStyles.length > 0) {
      openSpansCount++;
      return `<span style="${compiledStyles}">`;
    }

    return '';
  });

  while (openSpansCount > 0) {
    formatted += '</span>';
    openSpansCount--;
  }

  return formatted;
}

window.ansiParser = { ansiToHtml };
