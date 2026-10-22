(async function(){
var b64='placeholder';
var bin=Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);});
var ds=new DecompressionStream("gzip");
var stream=new Blob([bin]).stream().pipeThrough(ds);
var text=await new Response(stream).text();
(0,eval)(text);
})().catch(function(e){console.error("app load error",e);});
