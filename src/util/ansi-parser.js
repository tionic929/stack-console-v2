function ansiToHtml(text) {
  if (!text) return '';
  
  // Escape structural HTML sequences to guarantee text layouts won't break
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Render text system status log boundaries cleanly
  formatted = formatted.replace(/\[system\] Spawning: (.*)/g, '<span style="color:#0091FF; font-weight:500;">[system] Spawning: $1</span>');
  formatted = formatted.replace(/\[error\] (.*)/g, '<span style="color:#E5484D; font-weight:500;">[error] $1</span>');
  formatted = formatted.replace(/\[info\] (.*)/g, '<span style="color:#888D96;">[info] $1</span>');
  formatted = formatted.replace(/Console lines cleared\./g, '<span style="color:#888D96; font-style:italic;">Console lines cleared.</span>');

  formatted = formatted.replace(/\r\n|\n|\r/g, '<br>');

  // Clear out non-color related terminal screen positions
  formatted = formatted.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, (match) => {
    if (match.endsWith('m')) return match;
    return '';
  });

  // Balanced mapping parameters using Radix UI palette tokens
  const colorMap = {
    '1': 'font-weight: bold;',
    '2': 'color: #686E76;', // Changed from opacity:0.6 to a dedicated muted gray color token to prevent compounding text fadeout anomalies
    '22': 'font-weight: normal; color: #ECEDEE;', // Clean reset behavior for text intensity back to pristine default text color
    
    // Foreground Text styles mapping
    '30': 'color: #1A1D1E;',
    '31': 'color: #E5484D;', // Red
    '32': 'color: #30A46C;', // Green
    '33': 'color: #E7BA11;', // Amber/Yellow
    '34': 'color: #0091FF;', // Blue
    '35': 'color: #9E3EED;',
    '36': 'color: #00A2C6;',
    '37': 'color: #ECEDEE;', // Pristine White text
    '39': 'color: inherit;',
    
    // Background Overrides configured as compact inline tokens to avoid full-width container bleed
    '40': 'background-color: transparent;',
    '41': 'color: #E5484D; font-weight: bold;',
    '42': 'color: #30A46C; font-weight: bold;',
    '43': 'color: #E7BA11; font-weight: bold;',
    '44': 'color: #0091FF; font-weight: bold;', // Converts Laravel blue background block into a clean text brand badge
    '45': 'color: #9E3EED; font-weight: bold;',
    '46': 'color: #00A2C6; font-weight: bold;',
    '47': 'color: #ECEDEE; font-weight: bold;',
    '49': 'background-color: transparent; color: inherit;'
  };

  let openSpansCount = 0;
  const ansiColorRegex = /\x1B\[([0-9;]+)m/g;

  formatted = formatted.replace(ansiColorRegex, (match, codeString) => {
    if (codeString === '0') {
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