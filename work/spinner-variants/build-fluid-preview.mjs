import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../scripts/build-liquid-loader.mjs', import.meta.url), 'utf8')
  .replace("import { writeFileSync } from 'node:fs';", '').split('const css =')[0];
const variants = [
 ['Текущий', 'Мягкие волны с разной скоростью — текущая версия.', null],
 ['Ртуть', 'Крупные округлые наплывы, спокойная пластика.', '.27 * Math.sin(2 * phi + th + .6 * Math.sin(th)) + .08 * Math.sin(3 * phi - th) + .025 * Math.cos(4 * phi + 2 * th)'],
 ['Лава', 'Глубокие перетекания и выраженные мягкие лопасти.', '.29 * Math.sin(2 * phi + th) + .15 * Math.sin(3 * phi - 2 * th + .5 * Math.sin(th)) + .035 * Math.cos(4 * phi + th)'],
 ['Водоворот', 'Больше движения: волны обгоняют друг друга.', '.22 * Math.sin(2 * phi + 3 * th + .5 * Math.sin(th)) + .13 * Math.sin(3 * phi - 4 * th) + .04 * Math.cos(4 * phi + 5 * th)'],
 ['Три капли', 'Три широкие округлые доли плавно меняют объём.', '.24 * Math.sin(3 * phi - th + .55 * Math.sin(2 * th)) + .10 * Math.sin(2 * phi + 2 * th) + .025 * Math.cos(4 * phi - 3 * th)'],
 ['Живая капля', 'Асимметричная форма с перекатывающимися наплывами.', '.12 * Math.sin(phi - 2 * th) + .23 * Math.sin(2 * phi + th + .7 * Math.sin(th)) + .12 * Math.sin(3 * phi - 3 * th)']
];
const cards = variants.map(([name, description, flow], i) => {
 const code = flow ? source.replace(/const flow = [\s\S]*?;\n\t\tconst r =/, `const flow = ${flow};\n\t\tconst r =`) : source;
 const svg = vm.runInNewContext(code + '\nsvg({withShell:true,animated:true})');
 return `<article><header><span>0${i + 1}</span><h2>${name}</h2>${i === 0 ? '<b>В проекте</b>' : ''}</header><div class="stage">${svg}</div><p>${description}</p><div class="sizes">${[16,24,40].map(n => `<div><span style="width:${n}px;height:${n}px">${svg}</span><small>${n} px</small></div>`).join('')}</div></article>`;
}).join('');
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Жидкий центр — 6 вариантов</title><style>
*{box-sizing:border-box}body{margin:0;background:#13131b;color:#ededf6;font:15px system-ui,sans-serif;padding:40px;max-width:1440px;margin:auto}h1{font-size:30px;letter-spacing:-1px;margin:0 0 10px} .intro{color:#a3a3b7;margin:0 0 26px}.controls{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:26px}button,select{background:#292938;border:1px solid #44445b;color:#efeffa;border-radius:9px;padding:9px 14px;font:inherit}input{accent-color:#ac9aff;flex:1;min-width:150px}output{color:#b8abd9;font-variant-numeric:tabular-nums}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{background:#1c1c27;border:1px solid #303040;border-radius:18px;padding:20px}header{display:flex;align-items:center;gap:10px}header span{color:#9189b0;font-size:12px}h2{font-size:17px;margin:0}b{margin-left:auto;font-size:10px;color:#cec1ff;background:#35304c;padding:4px 7px;border-radius:6px}.stage{height:175px;display:grid;place-items:center}.stage svg{width:152px;height:152px}p{color:#aaaabc;font-size:13px;line-height:1.5;min-height:40px;margin:0 0 18px}.sizes{display:flex;gap:26px;border-top:1px solid #303040;padding-top:15px;align-items:center}.sizes div{display:flex;align-items:center;gap:8px}.sizes span{display:inline-block}.sizes svg{width:100%;height:100%}small{color:#84849b;font-size:11px}@media(max-width:950px){main{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:580px){body{padding:20px}main{grid-template-columns:1fr}}
</style><h1>Жидкий центр</h1><p class="intro">6 вариантов · одинаковые внешний контур, градиент и цикл 40 секунд. Отличается только пластика центра.</p><div class="controls"><button id="pause">Пауза</button><button id="restart">Сначала</button><label>Скорость <select id="speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label><input id="seek" aria-label="Позиция в цикле" type="range" min="0" max="40" step="0.1" value="4"><output id="time">4.0 с</output></div><main>${cards}</main><script>
const svgs=[...document.querySelectorAll('svg')],pause=document.querySelector('#pause'),seek=document.querySelector('#seek'),time=document.querySelector('#time');let playing=true,position=4,speed=1,previous=performance.now();
svgs.forEach(s=>{s.pauseAnimations();s.setCurrentTime(position)});
function draw(){svgs.forEach(s=>s.setCurrentTime(position));seek.value=position;time.value=position.toFixed(1)+' с'}
pause.onclick=()=>{playing=!playing;pause.textContent=playing?'Пауза':'Продолжить'};
document.querySelector('#restart').onclick=()=>{position=0;draw()};document.querySelector('#speed').onchange=e=>speed=Number(e.target.value);seek.oninput=e=>{position=Number(e.target.value);draw()};
function tick(now){if(playing){position=(position+Math.min((now-previous)/1000,.1)*speed)%40;draw()}previous=now;requestAnimationFrame(tick)}requestAnimationFrame(tick);
</script></html>`;
writeFileSync(new URL('fluid-six.html', import.meta.url), html);
console.log('Created fluid-six.html: six variants, synchronized playback and three interface sizes.');
