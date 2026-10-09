const subscriptions=[];
const terminalListeners=new Set();
const config={maxContextCharacters:200000};
const document={languageId:'typescript',getText:()=> 'const n = 2;\n'};
const api={
 Uri:{file:path=>({fsPath:path,toString:()=>path}),joinPath:(root,...paths)=>api.Uri.file(root.fsPath+'/'+paths.join('/')),from:({scheme,path})=>({toString:()=>scheme+':'+path}),parse:s=>({toString:()=>s})},
 workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/tmp'},name:'test'}],getConfiguration:()=>({get:(key,fallback)=>config[key]??fallback}),asRelativePath:x=>typeof x==='string'?x:x.fsPath,registerTextDocumentContentProvider:()=>({dispose(){}}),openTextDocument:async()=>document},
 window:{createTerminal:options=>({options,shows:0,show(){this.shows++;},__close(){for(const listener of terminalListeners) listener(this);}}),onDidCloseTerminal:listener=>{terminalListeners.add(listener);return {dispose(){terminalListeners.delete(listener);}};},createOutputChannel:()=>({append(){},appendLine(){},dispose(){}}),showQuickPick:async items=>items[0],showInformationMessage:async()=>{},showWarningMessage:async()=>undefined,showTextDocument:async()=>{}},
 commands:{executeCommand:async()=>{},registerCommand:()=>({dispose(){}})},env:{clipboard:{writeText:async()=>{}}},
 __config:config
};
module.exports=api;
