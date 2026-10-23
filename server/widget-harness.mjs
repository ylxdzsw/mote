export function widgetHarness(template, { html, width, height }) {
  return template
    .replace("Number(params.get('width') || 690)", String(width))
    .replace("Number(params.get('height') || 400)", String(height))
    .replace('frame.srcdoc =', 'frame.onload = () => { window.captureLoaded = true }; frame.srcdoc =')
    .replace('__MOTE_CANDIDATE_HTML__', () => JSON.stringify(html).replaceAll('<', '\\u003c'))
}
