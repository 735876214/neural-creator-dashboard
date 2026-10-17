import {skeleton, SPECS} from './src/neural/constellations.js';
const sp = SPECS.news;
console.log('stars:', sp.stars.length, 'edges:', sp.edges.length, 'pts:', sp.pts?.length);
// 每个 edge 的两端索引必须都在范围内
const bad = sp.edges.filter(([a,b]) => a >= sp.stars.length || b >= sp.stars.length);
console.log('越界边:', bad.length);
const sk = skeleton('news');
console.log('骨架点:', sk.length, '范围 x:', Math.min(...sk.map(p=>p.x)).toFixed(2), '..', Math.max(...sk.map(p=>p.x)).toFixed(2), ' y:', Math.min(...sk.map(p=>p.y)).toFixed(2), '..', Math.max(...sk.map(p=>p.y)).toFixed(2));
