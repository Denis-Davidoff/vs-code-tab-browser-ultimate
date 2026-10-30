import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clampPreviewZoom, previewPoint, previewZoomScroll } from '../../exchange-server/apps/web/app/components/preview-zoom.ts';

test('preview zoom stays between 25 and 400 percent',()=>{
 assert.equal(clampPreviewZoom(0.2),0.25);assert.equal(clampPreviewZoom(8),4);assert.equal(clampPreviewZoom(1.75),1.75);assert.equal(clampPreviewZoom(NaN),1);
});
test('zoom keeps the point under the pinch or wheel cursor anchored',()=>{
 const oldScroll=120,anchor=80,previous=1.5,next=3;
 const scroll=previewZoomScroll(oldScroll,anchor,previous,next);
 assert.equal(scroll,320);assert.equal((scroll+anchor)/next,(oldScroll+anchor)/previous);
 assert.equal(previewZoomScroll(0,100,2,1),0);
});
test('remote click coordinates exclude letterboxing and stay correct after zoom and pan',()=>{
 assert.deepEqual(previewPoint(200,300,{left:0,top:0,width:400,height:600},800,600),{x:0.5,y:0.5});
 assert.equal(previewPoint(200,50,{left:0,top:0,width:400,height:600},800,600),undefined);
 assert.deepEqual(previewPoint(200,200,{left:-200,top:-400,width:800,height:1200},800,600),{x:0.5,y:0.5});
});
