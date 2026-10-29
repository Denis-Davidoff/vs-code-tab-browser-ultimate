import { shell, ring, hexW, collapse } from './loader-base.mjs';

export const variants = [
  { name: 'Прилив', tag: '01 / КАЧАНИЕ', desc: 'Широкая волна перекатывается слева направо и обнимает стенку.', gap: .65, force: .68, mode: 0, speed: 3 },
  { name: 'Орбита', tag: '02 / КРУГОВОЙ НАКЛОН', desc: 'Жидкость непрерывно обходит сосуд, оставляя тонкий просвет.', gap: 1.6, force: .7, mode: 1, speed: 4 },
  { name: 'Восьмёрка', tag: '03 / ДВОЙНОЙ НАКЛОН', desc: 'Диагональный перелив с задержкой и обратной волной.', gap: 1.1, force: .8, mode: 2, speed: 3 },
  { name: 'Всплеск', tag: '04 / ИМПУЛЬС', desc: 'Быстрый бросок к стенке, растекание и упругий откат.', gap: .1, force: .88, mode: 3, speed: 4 },
  { name: 'Ртуть', tag: '05 / ВЯЗКОЕ ТЕЧЕНИЕ', desc: 'Плотная масса тянется вдоль контура и медленно отлипает.', gap: .45, force: .8, mode: 4, speed: 3 },
  { name: 'Водоворот', tag: '06 / БЫСТРЫЙ ОБОРОТ', desc: 'Бегущий наплыв у стенки и волна, догоняющая основной поток.', gap: 1.1, force: .82, mode: 5, speed: 6 },
];
export const DURATION = 40;
const TAU = Math.PI * 2, N = 64;
const mix = (a,b,t) => a+(b-a)*t;
export function geometry(t, cfg) {
  const cycle = t * TAU, spin = -4 * Math.PI * t;
  const raw = shell(cycle,40).match(/-?\d+(?:\.\d+)?/g).map(Number);
  const radii = Array.from({length:N},(_,i)=>Math.hypot(raw[i*2],raw[i*2+1])/10);
  const boundary = phi => {
    const f = ((phi-spin)/TAU % 1 + 1)%1*N, i = Math.floor(f);
    return mix(radii[i],radii[(i+1)%N],f-i);
  };
  const q = cycle * cfg.speed;
  let angle, strength = cfg.force;
  switch(cfg.mode) {
    case 0: angle = Math.PI/2 + 1.65*Math.sin(q); strength *= .78+.22*Math.cos(q)**2; break;
    case 1: angle = q+.22*Math.sin(2*q); break;
    case 2: angle = Math.atan2(Math.sin(2*q+.6),Math.cos(q)); strength *= .7+.3*Math.abs(Math.cos(q)); break;
    case 3: angle = Math.PI/2+1.7*Math.tanh(2.4*Math.sin(q)); strength *= .65+.35*Math.sin(q+.5)**2; break;
    case 4: angle = -q+.5*Math.sin(q); break;
    default: angle = q+.38*Math.sin(q); break;
  }
  // Anchor the original circle and hexagon; collapse all the way to the status dot.
  const hex = hexW(t), grow = collapse(t);
  const moving = (1-Math.exp(-((Math.sin(Math.PI*t)/.1)**2)))*(1-hex);
  const limits=[], desired=[];
  for(let i=0;i<N;i++) {
    const phi=i*TAU/N, a=phi-angle;
    limits.push(boundary(phi)-cfg.gap);
    desired.push(29*(1+moving*(strength*Math.cos(a)
      +.10*Math.sin(2*a-q)+.055*Math.sin(3*a+2*q))));
  }
  // Redistribute the same area around the wall instead of losing it to clipping.
  // A soft minimum gives a rounded meniscus as the liquid reaches the boundary.
  const capped = (r,wall) => -Math.log(Math.exp(-r/1.1)+Math.exp(-wall/1.1))*1.1;
  let lo=.4, hi=2.2;
  for(let step=0;step<18;step++) {
    const scale=(lo+hi)/2;
    const area=desired.reduce((sum,r,i)=>sum+capped(r*scale,limits[i])**2,0)/N;
    if(area>29**2)hi=scale;else lo=scale;
  }
  const rr=desired.map((r,i)=>{
    const liquid=capped(r*(lo+hi)/2,limits[i]);
    const spread=mix(liquid,boundary(i*TAU/N)*.74,hex);
    return spread*grow;
  });
  const core=ring(phi=>rr[Math.round(phi/TAU*N)%N],true);
  return { core, shell: shell(cycle,40), rotation:spin*180/Math.PI, area:rr.reduce((s,r)=>s+r*r,0)/N };
}

if(typeof document !== 'undefined') {
  const grid=document.querySelector('#grid');
  variants.forEach((cfg,i)=>{
    const card=document.createElement('article');
    card.innerHTML=`<div class="eyebrow">${cfg.tag}</div><div class="stage">${svg(i,148)}</div><h2>${cfg.name}</h2><p>${cfg.desc}</p><div class="sizes">${[16,24,32,48].map(size=>`<div>${svg(i+'s'+size,size)}<small>${size} px</small></div>`).join('')}</div>`;
    grid.append(card);
  });
  function svg(id,size){return `<svg width="${size}" height="${size}" viewBox="-500 -500 1000 1000" aria-label="Жидкий спиннер"><defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ac9aff"/><stop offset="1" stop-color="#71e2e1"/></linearGradient></defs><path class="dot" d="M0 0L0 0" stroke="#8fbef0" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/><path class="core" fill="url(#g${id})"/><path class="shell" fill="none" stroke="#ac9aff" stroke-opacity=".65" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;}
  const cards=[...grid.children].map(el=>({cores:el.querySelectorAll('.core'),shells:el.querySelectorAll('.shell')}));
  let elapsed=3.5, running=!matchMedia('(prefers-reduced-motion: reduce)').matches, last=0, rate=1;
  const play=document.querySelector('#play'), slider=document.querySelector('#time');
  play.textContent=running?'Пауза':'Продолжить';
  play.onclick=()=>{running=!running;play.textContent=running?'Пауза':'Продолжить';};
  document.querySelector('#speed').onchange=e=>rate=+e.target.value;
  slider.oninput=()=>{elapsed=+slider.value/100*DURATION;render();};
  document.querySelectorAll('[data-phase]').forEach(b=>b.onclick=()=>{elapsed=+b.dataset.phase*DURATION;render();});
  function render(){
    const t=(elapsed%DURATION)/DURATION;
    cards.forEach((card,i)=>{
      const g=geometry(t,variants[i]);
      card.cores.forEach(p=>p.setAttribute('d',g.core));
      card.shells.forEach(p=>{p.setAttribute('d',g.shell);p.setAttribute('transform',`rotate(${g.rotation})`);});
    });
    slider.value=t*100;
    document.querySelector('#clock').textContent=(t*DURATION).toFixed(1)+` / ${DURATION} с`;
  }
  function tick(now){if(now-last>=32){if(running&&last)elapsed+=(Math.min(now-last,100)/1000)*rate;last=now;render();}requestAnimationFrame(tick);}
  render();requestAnimationFrame(tick);
}
