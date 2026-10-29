import type { DocumentLanguage } from '../model'
import englishScreenshot from './focus-en.png?inline'
import chineseScreenshot from './focus-zh.png?inline'

export function focusWidget(language: DocumentLanguage) {
  const zh = language === 'zh-Hans'
  const title = zh ? '把一小时交给好奇心' : 'An hour for curiosity'
  const labels = zh ? ['阅读', '写作', '探索'] : ['Read', 'Write', 'Explore']
  const presets = zh ? ['均衡', '深入写作', '自由探索'] : ['Balanced', 'Deep writing', 'Open exploration']
  const hint = zh ? '选择一种节奏，看看时间如何分配。示意数据。' : 'Choose a rhythm to redistribute the time. Illustrative data.'
  const colors = ['#47684f', '#795c98', '#b27930']
  return {
    alt: title,
    screenshot: zh ? chineseScreenshot : englishScreenshot,
    html: `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#f4f6ef;color:#293b30;font:14px/1.5 system-ui,sans-serif}main{padding:22px 28px}h2{font-size:24px;line-height:1.3;margin:0 0 8px}p{margin:0 0 18px;font-size:13px}.row{display:flex;align-items:center;gap:12px;height:40px}.label{width:80px}.track{flex:1}.bar{height:22px;border-radius:3px;transition:width .3s}output{width:65px}nav{display:flex;gap:8px;margin-top:14px}button{font:inherit;color:inherit;border:1px solid #839481;background:transparent;border-radius:4px;padding:5px 12px;cursor:pointer}button[aria-pressed=true]{background:#293b30;color:#fff}button:focus-visible{outline:2px solid #795c98;outline-offset:2px}@media(prefers-reduced-motion:reduce){.bar{transition:none}}</style>
<main><h2>${title}</h2><p>${hint}</p><div aria-live="polite">${labels.map((label, i) => `<div class="row"><span class="label">${label}</span><div class="track"><div class="bar" style="background:${colors[i]};width:${[48, 40, 32][i]}%"></div></div><output>${[24, 20, 16][i]} min</output></div>`).join('')}</div><nav aria-label="${zh ? '时间分配' : 'Time allocation'}">${presets.map((preset, i) => `<button type="button" aria-pressed="${i === 0}" data-preset="${i}">${preset}</button>`).join('')}</nav></main>
<script>const values=[[24,20,16],[10,40,10],[15,10,35]];document.querySelectorAll('button').forEach(button=>button.onclick=()=>{const selected=Number(button.dataset.preset);document.querySelectorAll('button').forEach((item,i)=>item.setAttribute('aria-pressed',String(i===selected)));document.querySelectorAll('.row').forEach((row,i)=>{row.querySelector('.bar').style.width=values[selected][i]*2+'%';row.querySelector('output').textContent=values[selected][i]+' min'})});</script></html>`,
  }
}
