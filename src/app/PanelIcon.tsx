const paths = {
  anchor: 'M12 4v16M8 8h8M5 13H3a9 9 0 0 0 18 0h-2M9 20h6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  sliders: 'M6 3v5m0 4v9M3 8h6M12 3v11m0 4v3m-3-7h6m3-11v3m0 4v11m-3-15h6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M9 9h12v12H9zM15 5V3H3v12h2',
  chevron: 'm8 10 4 4 4-4',
  undo: 'm9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12',
  plus: 'M12 5v14M5 12h14',
  map: 'M4 3h16v18H4zM7 7h10M7 10h5m-5 4h10m-10 3h7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  book: 'M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z',
  edit: 'm4 16 12-12 4 4L8 20H4v-4Zm9-9 4 4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  reset: 'M4 11a8 8 0 1 1 2 7M4 4v7h7',
}

export function PanelIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="panel-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
