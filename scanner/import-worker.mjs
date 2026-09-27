import {parseDelimited} from './import-core.mjs';
import {decodeWorkbook} from './workbook-import.mjs';
onmessage=({data})=>{try{postMessage(data.xlsx?decodeWorkbook(data.bytes):{sheets:[{name:'CSV',rows:parseDelimited(data.text,data.delimiter),formulaCells:[]}],dateFormat:'iso'});}catch(e){postMessage({error:e.message});}};
