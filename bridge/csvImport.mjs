// Reading a CSV of finished flips from another tracker, so a new player does not start from nothing.
//
// Published with the bridge since 27 Sept 2026. It used to live in the browser scanner, which is in
// neither published repository -- so the only history import a Plugin Hub user could reach was the
// Exchange Logger one, and anyone who had never run that plugin had no route at all. A player own
// history is meant to be an extra safety layer rather than a requirement, and it cannot be either if
// there is no way to hand it over.
//
// Deliberately not written for any one tracker. It parses a delimited file, guesses which column is
// which from a list of names trackers actually use, and reports what it matched so a person can see
// whether the guess was right before anything is written. Nothing here knows or cares which program
// produced the file.
//
// Pure and local: no fetching, no disk, no dates beyond parsing the ones in the file. Safe to serve to
// the browser, which is how the setup page uses it.
export const FIELDS=['item','profit','capital','quantity','buyPrice','netProceeds','boughtAt','soldAt','sourceId','account'];
const MAX_ROWS=50000,MAX_COLUMNS=256;

export function parseDelimited(text,delimiter=',') {
  if(typeof text!=='string'||text.length>10000000)throw Error('File exceeds the 10 MB text limit.');
  if(![',',';','\t'].includes(delimiter))throw Error('Choose comma, semicolon or tab.');
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  const pushCell=()=>{row.push(cell);cell='';closed=false;if(row.length>MAX_COLUMNS)throw Error('Too many columns.');};
  const pushRow=()=>{pushCell();rows.push(row);row=[];if(rows.length>MAX_ROWS+1)throw Error('Too many rows.');};
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {
      if(c==='"') {if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}
      else cell+=c;
    } else if(c===delimiter)pushCell();
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();}
    else if(c==='"'){if(cell.length||closed)throw Error('Unexpected quote in CSV.');quoted=true;}
    else if(closed){if(!/\s/.test(c))throw Error('Unexpected text after a quoted cell.');}
    else cell+=c;
  }
  if(quoted)throw Error('Unclosed quoted cell.');
  if(cell.length||row.length||closed)pushRow();
  return rows;
}

export function parseNumber(value,decimal='.') {
  if(value===null||value===undefined||String(value).trim()==='')return null;
  if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw Error('Number is outside the supported range.');return value;}
  if(!['.',','].includes(decimal))throw Error('Choose a decimal separator.');
  let s=String(value).trim();
  const pattern=decimal==='.'?/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/:/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/;
  if(!pattern.test(s))throw Error('Invalid number for the selected decimal separator.');
  s=decimal==='.'?s.replaceAll(',',''):s.replaceAll('.','').replace(',','.');
  const n=Number(s);if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER)throw Error('Number is outside the supported range.');return n;
}

export function parseTime(value,format='iso',offsetMinutes=0) {
  if(value===null||value===undefined||String(value).trim()==='')return null;
  if(format==='excel1900'||format==='excel1904') {
    if(!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>840)throw Error('Invalid worksheet timezone offset.');
    const serial=typeof value==='number'?value:Number(String(value).trim());
    if(!Number.isFinite(serial)||serial<0||serial>2958465)throw Error('Invalid Excel date serial.');
    if(format==='excel1900'&&serial>=60&&serial<61)throw Error('Excel date 1900-02-29 is not a real date.');
    const epoch=format==='excel1904'?Date.UTC(1904,0,1):Date.UTC(1899,11,31);
    const days=format==='excel1900'&&serial>=61?serial-1:serial;
    return Math.round(epoch+days*86400000-offsetMinutes*60000);
  }
  if(format!=='iso')throw Error('Unsupported date format.');
  const s=String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s))throw Error('Use ISO timestamps with Z or an explicit timezone offset.');
  const n=Date.parse(s);if(!Number.isFinite(n))throw Error('Invalid timestamp.');
  const [year,month,day]=s.slice(0,10).split('-').map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())throw Error('Invalid calendar date.');
  return n;
}

const aliases={item:['item','item name','name'],profit:['profit','net profit','profit after tax'],capital:['capital','buy total','total cost'],quantity:['quantity','qty'],buyPrice:['avg. buy price','buy price'],netProceeds:['net proceeds','sale proceeds after tax'],boughtAt:['first buy time','buy time','bought at'],soldAt:['last sell time','sell time','sold at'],sourceId:['trade id','transaction id'],account:['account','character']};
export function suggestMapping(headers) {
  const result={};
  for(const [field,names] of Object.entries(aliases)) {
    const matches=headers.map((h,i)=>names.includes(String(h).trim().toLowerCase())?i:-1).filter(i=>i>=0);
    if(matches.length===1)result[field]=matches[0];
  }
  return result;
}

export function previewTable(table,mapping,options={}) {
  if(!Array.isArray(table)||table.length<2||table.length>MAX_ROWS+1)throw Error('Choose a table with a header and at least one trade.');
  const width=table[0].length;
  if(width>MAX_COLUMNS)throw Error('Too many columns.');
  for(const [field,index] of Object.entries(mapping))if(!FIELDS.includes(field)||!Number.isInteger(index)||index<0||index>=width)throw Error('Invalid column mapping.');
  if(mapping.item===undefined)throw Error('Map the item column.');
  if(mapping.profit===undefined&&mapping.netProceeds===undefined)throw Error('Map net profit or actual net sale proceeds.');
  if(options.profitMeaning!=='after-tax')throw Error('Confirm that the mapped profit or proceeds is after tax. Gross values need explicit tax information.');
  const source=String(options.source||'').trim();if(!source||source.length>100)throw Error('Name this log source.');
  const records=[],errors=[],warnings=[],seen=new Map();
  for(let i=1;i<table.length;i++) {
    const row=table[i];if(!Array.isArray(row)){errors.push({row:i+1,message:'Invalid worksheet row.'});continue;}
    if(row.every(v=>v==null||String(v).trim()===''))continue;
    try {
      const read=f=>mapping[f]===undefined?null:row[mapping[f]];
      const num=f=>parseNumber(read(f),options.decimal||'.');
      const item=String(read('item')??'').trim();if(!item||item.length>200)throw Error('Missing or overly long item name.');
      if(['__proto__','constructor','prototype'].includes(item.toLowerCase()))throw Error('Invalid item name.');
      const quantity=num('quantity'),price=num('buyPrice');let capital=num('capital'),profit=num('profit');
      if(quantity!==null&&(!Number.isSafeInteger(quantity)||quantity<=0))throw Error('Quantity must be a positive whole number.');
      if(price!==null&&price<0)throw Error('Buy price cannot be negative.');
      if(capital===null&&quantity!==null&&price!==null)capital=quantity*price;
      if(capital!==null&&(!Number.isFinite(capital)||capital<0||capital>Number.MAX_SAFE_INTEGER))throw Error('Invalid total cost.');
      const proceeds=num('netProceeds');if(proceeds!==null&&proceeds<0)throw Error('Net proceeds cannot be negative.');
      if(profit===null){if(proceeds===null||capital===null)throw Error('Profit cannot be derived without net proceeds and cost.');profit=proceeds-capital;}
      if(!Number.isSafeInteger(profit))throw Error('Net profit must be a whole GP amount.');
      if(proceeds!==null&&capital!==null&&Math.abs(profit-(proceeds-capital))>0.5)throw Error('Profit conflicts with proceeds minus cost.');
      const boughtAt=parseTime(read('boughtAt'),options.dateFormat||'iso',options.timezoneOffsetMinutes||0);
      const soldAt=parseTime(read('soldAt'),options.dateFormat||'iso',options.timezoneOffsetMinutes||0);
      if(boughtAt!==null&&soldAt!==null&&soldAt<boughtAt)throw Error('Sell time precedes buy time.');
      const hold=boughtAt!==null&&soldAt!==null?(soldAt-boughtAt)/3600000:null;
      const sourceId=String(read('sourceId')??'').trim(),account=String(read('account')??'').trim();
      if(sourceId.length>200||account.length>100)throw Error('Source ID or account label is too long.');
      const signature=JSON.stringify([item.toLowerCase(),account,quantity,capital,profit,boughtAt,soldAt]);
      const fp='generic:'+JSON.stringify(sourceId?[source,account,sourceId]:[source,signature]);
      const previous=seen.get(fp);
      const duplicate=previous?(previous.signature===signature?'repeat':'conflicting-id'):null;
      if(duplicate==='conflicting-id')throw Error('The same source ID has conflicting trade values.');
      if(!previous)seen.set(fp,{row:i+1,signature});
      if(!sourceId)warnings.push({row:i+1,message:'No trade ID: identical trades need review before deduplication.'});
      if(hold===null)warnings.push({row:i+1,message:'Hold time unavailable; it will not be guessed.'});
      records.push({row:i+1,fp,source,sourceId:sourceId||null,account:account||null,item,quantity,capital,profit,hold,roi:capital>0?profit/capital:null,win:profit>0,loss:profit<0,boughtAt,soldAt,duplicateOf:previous?.row??null,identityStrength:sourceId?'source-id':'values'});
    }catch(error){errors.push({row:i+1,message:error.message});}
  }
  return {records,errors,warnings};
}
