import {read,utils} from './vendor/xlsx.mjs';

// Bound archive expansion before the spreadsheet parser decompresses XML.
export function checkWorkbookArchive(input) {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>10000000)throw Error('Workbook exceeds the 10 MB file limit.');
  if(bytes.length<22)throw Error('Not an XLSX workbook.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--) {
    if(view.getUint32(p,true)===0x06054b50&&p+22+view.getUint16(p+20,true)===bytes.length){end=p;break;}
  }
  if(end<0)throw Error('Workbook ZIP directory is missing.');
  const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||count!==view.getUint16(end+8,true)||count===65535||count>4096||start+size!==end)throw Error('Unsupported or oversized workbook archive.');
  let cursor=start,total=0;const names=new Set();
  for(let i=0;i<count;i++) {
    if(cursor+46>end||view.getUint32(cursor,true)!==0x02014b50)throw Error('Invalid workbook ZIP entry.');
    const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),expanded=view.getUint32(cursor+24,true);
    const nameLength=view.getUint16(cursor+28,true),extra=view.getUint16(cursor+30,true),comment=view.getUint16(cursor+32,true);
    const next=cursor+46+nameLength+extra+comment;
    if(next>end||flags&1||![0,8].includes(method)||expanded>16000000)throw Error('Encrypted or oversized workbook entry.');
    total+=expanded;if(total>32000000)throw Error('Expanded workbook exceeds 32 MB.');
    const name=new TextDecoder().decode(bytes.subarray(cursor+46,cursor+46+nameLength));
    if(names.has(name)||name.includes('..')||name.startsWith('/')||name.includes('\\'))throw Error('Invalid workbook entry name.');
    if(/vbaproject|externallinks/i.test(name))throw Error('Macro content and external workbook links are not supported.');
    names.add(name);cursor=next;
  }
  if(cursor!==end||!names.has('xl/workbook.xml')||!names.has('[Content_Types].xml'))throw Error('Choose an XLSX workbook.');
  return bytes;
}

export function decodeWorkbook(input) {
  const bytes=checkWorkbookArchive(input);
  const workbook=read(bytes,{type:'array',dense:true,cellFormula:true,cellHTML:false,cellDates:false,bookVBA:false,sheetRows:50002});
  if(workbook.SheetNames.length>32)throw Error('Workbook has more than 32 worksheets.');
  const sheets=workbook.SheetNames.map(name=>{
    const sheet=workbook.Sheets[name],range=utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
    if(range.e.r>=50001||range.e.c>=256)throw Error('Worksheet exceeds 50,000 trade rows or 256 columns.');
    const formulas=[];
    for(let r=0;r<(sheet['!data']||[]).length;r++)for(let c=0;c<(sheet['!data'][r]||[]).length;c++) {
      const cell=sheet['!data'][r]?.[c];if(cell?.f)formulas.push(utils.encode_cell({r,c}));
    }
    return {name,rows:utils.sheet_to_json(sheet,{header:1,raw:true,defval:null,blankrows:true}),formulaCells:formulas};
  });
  return {sheets,dateFormat:workbook.Workbook?.WBProps?.date1904?'excel1904':'excel1900'};
}
