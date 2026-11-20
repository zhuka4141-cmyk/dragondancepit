import { viewerMessages } from './viewer-messages.js';

const staticMessages = {
  description: ['Dragondance 賽車 3D 檢視器，支援正交視角、零件拆解與模型表面繪畫。', 'View the Dragondance race car in 3D, take it apart, and paint on its surfaces.'],
  stage: ['賽車 3D 視圖', '3D race car view'],
  cameraControls: ['繪畫視角控制', 'Painting camera controls'],
  stickLabel: ['視角搖桿，按住方向鍵可旋轉', 'Camera joystick. Hold an arrow key to rotate.'],
  stickTitle: ['拖曳搖桿旋轉，或按住方向鍵', 'Drag the joystick or hold an arrow key to rotate'],
  zoomIn: ['放大視角', 'Zoom in'],
  zoomOut: ['縮小視角', 'Zoom out'],
  archive: ['3D 數位檔案', '3D Archive'],
  format: ['格式', 'Format'],
  dimensions: ['外形尺寸', 'Dimensions'],
  parts: ['零件', 'Parts'],
  triangles: ['三角面', 'Triangles'],
  mouseHelp: ['左鍵拖曳旋轉 · 滾輪縮放 · 右鍵平移', 'Left drag to orbit · Scroll to zoom · Right drag to pan'],
  views: ['正交視角', 'Orthographic Views'],
  front: ['前視', 'Front'],
  back: ['後視', 'Rear'],
  left: ['左視', 'Left'],
  right: ['右視', 'Right'],
  top: ['俯視', 'Top'],
  bottom: ['仰視', 'Bottom'],
  iso: ['等角視圖', 'Isometric'],
  close: ['關閉工具面板', 'Close tool panel'],
  closeTitle: ['關閉（Esc）', 'Close (Esc)'],
  paintTools: ['繪畫工具', 'Painting tools'],
  interactionMode: ['操作模式', 'Interaction mode'],
  automatic: ['自動', 'Auto'],
  orbitMode: ['旋轉檢視', 'Orbit'],
  paintMode: ['畫筆模式', 'Paint mode'],
  swatches: ['快速選色', 'Color swatches'],
  customColor: ['自訂顏色', 'Custom color'],
  brushSize: ['大小', 'Brush size'],
  opacity: ['不透明度', 'Opacity'],
  pressure: ['感壓（筆觸大小與不透明度）', 'Pen pressure (size and opacity)'],
  brushTools: ['畫筆工具', 'Brush tools'],
  brush: ['畫筆', 'Brush'],
  eraser: ['橡皮擦', 'Eraser'],
  undo: ['復原', 'Undo'],
  undoTitle: ['復原上一筆（Ctrl+Z）', 'Undo last stroke (Ctrl+Z)'],
  redo: ['重做', 'Redo'],
  redoTitle: ['重做（Ctrl+Shift+Z）', 'Redo (Ctrl+Shift+Z)'],
  clear: ['清除', 'Clear'],
  exportDrawing: ['匯出塗鴉', 'Export drawing'],
  importDrawing: ['匯入塗鴉', 'Import drawing'],
  disassemblyTools: ['零件拆解工具', 'Disassembly tools'],
  partGroups: ['零件群組', 'Part groups'],
  separateAll: ['全部拆開', 'Separate all'],
  assembleAll: ['全部組回', 'Assemble all'],
  distance: ['拆解距離', 'Separation'],
  groupHint: ['點選模型上的零件可切換所屬群組。', 'Select a part on the model to toggle its group.'],
  viewerTools: ['檢視器工具', 'Viewer tools'],
  explodeTitle: ['零件拆解（X）', 'Disassemble parts (X)'],
  draw: ['繪畫', 'Paint'],
  drawTitle: ['繪畫（D）', 'Paint (D)'],
  rotate: ['自動旋轉', 'Auto-rotate'],
  rotateTitle: ['自動旋轉（R）', 'Auto-rotate (R)'],
  wireframe: ['線框', 'Wireframe'],
  wireframeTitle: ['線框（W）', 'Wireframe (W)'],
  grid: ['格線', 'Grid'],
  gridTitle: ['格線（G）', 'Grid (G)'],
  outline: ['輪廓線', 'Outlines'],
  outlineTitle: ['輪廓線（E）', 'Outlines (E)'],
  reset: ['重設', 'Reset'],
  resetLabel: ['重設視角', 'Reset view'],
  resetTitle: ['重設視角（0）', 'Reset view (0)'],
  screenshot: ['截圖', 'Screenshot'],
  screenshotTitle: ['儲存截圖（S）', 'Save screenshot (S)'],
  fullscreen: ['全螢幕', 'Fullscreen'],
  fullscreenTitle: ['全螢幕（F）', 'Fullscreen (F)'],
  dragHint: ['拖曳旋轉', 'Drag to orbit'],
  loading: ['正在載入 Dragondance', 'Loading Dragondance'],
  loadingModel: ['正在讀取 3D 模型…', 'Reading the 3D model…'],
  loadFailed: ['模型載入失敗', 'Failed to load the model'],
  loadHelp: ['請確認模型檔案可存取，並透過 HTTP 或 HTTPS 開啟檢視器。', 'Check that the model file is available and open the viewer over HTTP or HTTPS.'],
  chooseLanguage: ['介面語言 / Language', 'Language / 介面語言'],
  startupFailed: ['無法啟動檢視器，請重新整理頁面。', 'The viewer could not start. Reload the page to try again.'],
};

const messages = { ...staticMessages, ...viewerMessages };
const storageKey = 'dragondance-viewer-language';
const listeners = new Set();
let language = 'zh-Hant';

try {
  if (localStorage.getItem(storageKey) === 'en') language = 'en';
} catch {
  // The switch still works when browser storage is unavailable.
}

export function t(key, params = {}) {
  const pair = Object.hasOwn(messages, key) ? messages[key] : undefined;
  return (pair?.[language === 'en' ? 1 : 0] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function onLanguageChange(listener) {
  listeners.add(listener);
}

export function initLanguage() {
  const control = document.getElementById('viewer-language');
  const attributes = { title: 'title', label: 'aria-label', content: 'content' };
  const render = () => {
    document.documentElement.lang = language;
    control.value = language;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const [field, attribute] of Object.entries(attributes)) {
      const source = `data-i18n-${field}`;
      for (const element of document.querySelectorAll(`[${source}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(source)));
      }
    }
  };
  render();
  control.addEventListener('change', () => {
    language = control.value === 'en' ? 'en' : 'zh-Hant';
    try { localStorage.setItem(storageKey, language); } catch { /* session-only preference */ }
    render();
    for (const listener of listeners) listener();
  });
}
