/* Local-only rendering. Untrusted TeX never receives HTML/URL permissions. */
if (window.temml) {
  window.temml.renderMathInElement(document.body, {
    delimiters: [
      {left:'$$', right:'$$', display:true},
      {left:'\\[', right:'\\]', display:true},
      {left:'\\(', right:'\\)', display:false}
    ],
    throwOnError:false,
    trust:false
  });
}
