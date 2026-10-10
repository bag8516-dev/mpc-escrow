const {ethers}=require('ethers'); const fs=require('fs');
const A='0x98965474EcBeC2F532F1f780ee37b0b05F77Ca55'; const TR=ethers.id('Transfer(address,address,uint256)'); const Z='0x'+'0'.repeat(64);
const SC='C:/Users/박세진/AppData/Local/Temp/claude/C--Users-----OneDrive-Desktop-----/efba27da-a500-4bba-b8e1-266c617875b0/scratchpad';
const ST=SC+'/sut_full_state.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const prov=[new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com',137,{staticNetwork:true}),new ethers.JsonRpcProvider('https://rpc-mainnet.matic.quiknode.pro',137,{staticNetwork:true})];
(async()=>{
 // 30일 작업이 끝날 때까지 대기 (출력 파일 생성 확인)
 while(!fs.existsSync(SC+'/sut_30d_flow.json')){ await new Promise(r=>setTimeout(r,60000)); }
 console.log('30일 작업 완료 확인, 전체 스캔 시작');
 const N0=await prov[0].getBlockNumber();
 let st=fs.existsSync(ST)?JSON.parse(fs.readFileSync(ST)):{cursor:N0,logs:[],mintSum:0};
 const TOTAL=238403732;
 while(st.mintSum<TOTAL*0.999 && st.cursor>0){
  const from=Math.max(0,st.cursor-9499); let ok=false;
  for(let t=0;t<6&&!ok;t++){ try{
    const l=await prov[t%2].getLogs({address:A,fromBlock:from,toBlock:st.cursor,topics:[TR]});
    for(const x of l){ st.logs.push({b:x.blockNumber,f:x.topics[1],to:x.topics[2],v:x.data});
      if(x.topics[1]===Z) st.mintSum+=Number(ethers.formatUnits(BigInt(x.data),18)); }
    ok=true; }catch(e){ await sleep(600*(t+1)); } }
  st.cursor=from-1;
  if(st.logs.length%5000<50 || st.cursor%500000<9500) fs.writeFileSync(ST,JSON.stringify(st));
  await sleep(120);
 }
 fs.writeFileSync(ST,JSON.stringify(st));
 console.log('스캔 종료: 로그',st.logs.length,'건, 민팅 합계',Math.round(st.mintSum).toLocaleString(),'커서 블록',st.cursor);
 const bal={};
 for(const x of st.logs){ const f='0x'+x.f.slice(26), t='0x'+x.to.slice(26), v=Number(ethers.formatUnits(BigInt(x.v),18)); bal[f]=(bal[f]||0)-v; bal[t]=(bal[t]||0)+v; }
 delete bal['0x0000000000000000000000000000000000000000'];
 const hold=Object.entries(bal).filter(([a,v])=>v>0.000001).sort((a,b)=>b[1]-a[1]);
 console.log('보유 지갑 수:',hold.length);
 let out=['순위 | 주소 | 보유량 | 비중'];
 for(let i=0;i<Math.min(25,hold.length);i++){ const [a,v]=hold[i]; let kind='?'; try{ kind=(await prov[0].getCode(a))==='0x'?'EOA':'컨트랙트'; }catch(e){}
  out.push((i+1)+' | '+a+' | '+Math.round(v).toLocaleString()+' | '+(v/TOTAL*100).toFixed(2)+'% | '+kind); }
 const top10=hold.slice(0,10).reduce((s,[,v])=>s+v,0), top25=hold.slice(0,25).reduce((s,[,v])=>s+v,0);
 out.push('상위10 합계 '+(top10/TOTAL*100).toFixed(1)+'% | 상위25 합계 '+(top25/TOTAL*100).toFixed(1)+'%');
 const bins={'100만+':0,'10만~100만':0,'1만~10만':0,'1천~1만':0,'1천 미만':0};
 for(const [,v] of hold){ if(v>=1e6)bins['100만+']++; else if(v>=1e5)bins['10만~100만']++; else if(v>=1e4)bins['1만~10만']++; else if(v>=1e3)bins['1천~1만']++; else bins['1천 미만']++; }
 out.push('구간별: '+JSON.stringify(bins));
 console.log(out.join('\n'));
 fs.writeFileSync(SC+'/sut_holders.txt',out.join('\n'));
})().catch(e=>console.log('ERR',e.message));
