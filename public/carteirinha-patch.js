/* Patch v25 loader (compartilhar + fontes) */
(function(){
  function go(){
    var parts=[];
    for(var i=0;i<5;i++){
      var p=window['__CV_P'+i];
      if(!p){return false;}
      parts.push(p);
    }
    try{
      var bin=atob(parts.join(''));
      var code=decodeURIComponent(escape(bin));
      (0,eval)(code);
    }catch(e){console.error('patch v25',e);}
    return true;
  }
  var left=5;
  function loadOne(i){
    var s=document.createElement('script');
    s.src='/carteirinha-patch.p'+i+'.js?v=25';
    s.onload=function(){left--;if(left<=0)go();};
    s.onerror=function(){console.error('fail chunk',i);};
    document.head.appendChild(s);
  }
  for(var i=0;i<5;i++)loadOne(i);
})();
