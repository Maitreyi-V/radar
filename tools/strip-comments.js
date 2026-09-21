const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
// remove block comments, then line comments, then blank lines + whitespace
let s=src.replace(/\/\*[\s\S]*?\*\//g,'');
s=s.split('\n').map(l=>l.replace(/\/\/.*$/,'')).map(l=>l.trim()).filter(l=>l.length).join('\n');
process.stdout.write(s);
