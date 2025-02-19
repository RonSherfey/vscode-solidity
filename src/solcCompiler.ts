'use strict';
import { errorToDiagnostic } from './solErrorsToDiagnostics';
import * as solc from 'solc';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { ContractCollection } from './model/contractsCollection';
import { initialiseProject } from './projectService';
import { resolve, resolveModulePath } from 'vscode-languageserver/lib/files';
import { fileURLToPath } from 'url';

export enum compilerType {
    localNodeModule,
    remote,
    localFile,
    embedded,
}

export abstract class SolcCompilerLoader {
    
    public compilerType: compilerType;
    
    public localSolc: any;
    
    public getVersion(): string {
        return this.localSolc.version();
    }

    public abstract matchesConfiguration(configuration: string): boolean;
    public abstract canCompilerBeLoaded(): boolean;
    public abstract getConfiguration(): any;
    public abstract initialiseCompiler(): Promise<void>;

    public isInitialisedAlready(configuration: string = null): boolean {
        if (this.localSolc === null) return false;
        return this.matchesConfiguration(configuration);
    }
}

export class EmbeddedCompilerLoader extends SolcCompilerLoader {
    
    public matchesConfiguration(configuration: string): boolean {
        return true;
    }

    public getConfiguration() {
        return "";
    }

    constructor() {
        super();
        this.compilerType = compilerType.embedded
    }

    public init() {
        this.localSolc = null;
    }

    public canCompilerBeLoaded(): boolean {
        return true;
    }


    public initialiseCompiler(): Promise<void>{ 
        return new Promise<void>((resolve, reject) => {
            this.localSolc = require('solc');
            resolve();
        });
    }
}


export class NpmModuleCompilerLoader extends SolcCompilerLoader {
    
    private npmModule: string;
    private rootPath: string;

    public matchesConfiguration(configuration: string): boolean {
        return configuration === this.npmModule;
    }

    public getConfiguration() {
        return this.npmModule;
    }

    constructor() {
        super();
        this.npmModule = "solc";
        this.compilerType = compilerType.localNodeModule
    }

    public init(rootPath: string, npmModule:string = "solc") {
        this.rootPath = rootPath;
        if(!this.matchesConfiguration(npmModule)) {
            this.npmModule = npmModule;
            this.localSolc = null;

        }
    }

    public canCompilerBeLoaded(): boolean {
        return this.isInstalledSolcUsingNode(this.rootPath);
    }

    public getLocalSolcNodeInstallation() {
        return path.join(this.rootPath, 'node_modules', this.npmModule, 'soljson.js');
    }

    public isInstalledSolcUsingNode(rootPath: string): boolean {
        return fs.existsSync(this.getLocalSolcNodeInstallation());
    }

    public initialiseCompiler(): Promise<void>{ 
        return new Promise<void>((resolve, reject) => {
            if(this.isInitialisedAlready(this.npmModule)) {
                resolve();
            }
            if(this.canCompilerBeLoaded()) {
                try {
                    let solidityfile = require(this.getLocalSolcNodeInstallation());
                    this.localSolc = solc.setupMethods(solidityfile);
                    resolve();
                } catch(e) {
                    this.localSolc = null;
                    reject("An error has ocurred, loading the compiler from Node Modules, located at:" + this.getLocalSolcNodeInstallation() + ", " + e);
                }
            } else {
                this.localSolc = null;
                reject("Compiler cannot be loaded from: " + this.getLocalSolcNodeInstallation());
            }
        });
    }
}


export class LocalPathCompilerLoader extends SolcCompilerLoader {
    
    private localPath: string;

    public matchesConfiguration(configuration: string): boolean {
        return configuration === this.localPath;
    }

    public getConfiguration() {
        return this.localPath;
    }

    constructor() {
        super();
        this.compilerType = compilerType.localFile
    }

    public init(localPath:string) {
        if(!this.matchesConfiguration(localPath)) {
            this.localPath = localPath;
            this.localSolc = null;
        }
    }

    public canCompilerBeLoaded(): boolean {
        if(typeof this.localPath !== 'undefined' && this.localPath !== null && this.localPath !== '') {
            return this.compilerExistsAtPath(this.localPath);
        }
        return false;
    }
    public compilerExistsAtPath(localPath: string): boolean {
        return fs.existsSync(localPath);
    }

    public initialiseCompiler(): Promise<void>{ 
        return new Promise<void>((resolve, reject) => {
            if(this.isInitialisedAlready(this.localPath)) {
                resolve();
            }
            if(this.canCompilerBeLoaded()) {
                try {
                    let solidityfile = require(this.localPath);
                    this.localSolc = solc.setupMethods(solidityfile);
                    resolve();
                } catch(e) {
                    this.localSolc = null;
                    reject("An error has ocurred, loading the compiler located at:" + this.localPath + ", " + e);
                }
            } else {
                this.localSolc = null;
                reject("Compiler cannot be loaded from: " + this.localPath);
            }
        });
    }
}

export class RemoteCompilerDownloader {
     public downloadCompilationFile(version:string, path:string): Promise<void> {
        const file = fs.createWriteStream(path);
        const url = 'https://binaries.soliditylang.org/bin/soljson-' + version + '.js';
        return new Promise((resolve, reject) => {
                const request = https.get(url, function (response) {
                        if (response.statusCode !== 200) {
                            reject('Error retrieving solidity compiler: ' + response.statusMessage);
                        } else {
                            response.pipe(file);    
                            file.on("finish", function(){
                                file.close();
                                resolve();
                            });
                        }
                }).on('error', function (error) {
                    reject(error);
                }); 
                request.end(); 
            });
    }
}


export class RemoteReleases {
    public getSolcReleases(): Promise<any> {
        const url = 'https://binaries.soliditylang.org/bin/list.json';
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    try {
                        const binList = JSON.parse(body);
                        resolve(binList.releases);
                    } catch (error) {
                        reject(error.message);
                    }
                });
            }).on('error', (error) => {
                reject(error.message);
            });
        });
    }

    public getFullVersionFromFileName(fileName: string): string {
        let version = '';    
        const value: string = fileName;
        if (value !== 'undefined') {
            version = value.replace('soljson-', '');
            version = version.replace('.js', '');
        } else { 
            throw("Remote version: Invalid file name");
        }
        return version;
    }

    public async resolveRelease(version: string): Promise<string> {
        return new Promise(async (resolve, reject) => {
                try {
                    let releases = await this.getSolcReleases();
                    for (const release in releases) {
                        let fullVersion = this.getFullVersionFromFileName(releases[release]);
                        if(version == fullVersion) resolve(fullVersion);
                        if(version == release) resolve(fullVersion);
                        if(version == releases[release]) resolve(fullVersion);
                        if("v" + release == version) resolve(fullVersion);
                        if(version.startsWith("v" + release + "+commit")) resolve(fullVersion);
                    }
                    reject("Remote version: invalid version");
                }
                catch(error) {
                    reject(error);
                }
        });
    }
}

export class RemoteCompilerLoader extends SolcCompilerLoader {
    
    private version: string;
    private solcCachePath: string;

    public getConfiguration() {
        return this.version;
    }

    public matchesConfiguration(configuration: string): boolean {
        return configuration === this.version;
    }

    public setSolcCache(solcCachePath: string): void {
        this.solcCachePath = solcCachePath;
    }

    constructor() {
        super();
        this.compilerType = compilerType.remote;
    }

    public init(version:string) {
        if(!this.matchesConfiguration(version)) {
            this.version = version;
            this.localSolc = null;
        }
    }

    public canCompilerBeLoaded(): boolean {
        //this should check if the string version is valid
        if(typeof this.version !== 'undefined' && this.version !== null && this.version !== '') {
            return true;
        }
        return false;
    }
   

    public initialiseCompiler(): Promise<void>{ 
        return new Promise<void>((resolve, reject) => {
            if(this.isInitialisedAlready(this.version)) {
                resolve();
            }
            if(this.canCompilerBeLoaded()) {
                const solcService = this;
                new RemoteReleases().resolveRelease(this.version).then(resolvedVersion => 
                    this.loadRemoteVersionRetry(resolvedVersion, 1, 3).then((solcSnapshot) => {
                            solcService.localSolc = solcSnapshot;
                            resolve();
                        }).catch((error) =>
                        {
                            reject('There was an error loading the remote version: ' + this.version + ',' + error)
                        })
                    ).catch((error) =>
                    {
                        reject('There was an error loading the remote version: ' + this.version + ',' + error)
                    })
            } else {
                this.localSolc = null;
                reject("Compiler cannot load remote version:" + this.version);
            }
        });
    }

   

    private loadRemoteVersionRetry (versionString: string, retryNumber: number, maxRetries: number): Promise<any> {
        return new Promise((resolve, reject) => { 
            this.loadRemoteVersion(versionString).then((solcConfigured) => resolve(solcConfigured)).catch((reason) =>
            {
                if(retryNumber <= maxRetries) {
                    return this.loadRemoteVersionRetry(versionString, retryNumber + 1, maxRetries);
                }else{
                    reject(reason);
                }
            }
        );
        });
    }

    private loadRemoteVersion (versionString: string): Promise<any> {
        const pathVersion = path.resolve(path.join(this.solcCachePath, 'soljson-' + versionString + '.js'));
        return new Promise((resolve, reject) => { 
                try {
                        if (fs.existsSync(pathVersion) && versionString !== 'latest') {
                                const solidityfile = require(pathVersion);
                                const solcConfigured = solc.setupMethods(solidityfile);
                                resolve(solcConfigured);
                        } else {
                            new RemoteCompilerDownloader().downloadCompilationFile(versionString, pathVersion).then(() => {
                                const solidityfile = require(pathVersion);
                                const solcConfigured = solc.setupMethods(solidityfile);
                                resolve(solcConfigured);
                            }).catch((reason) => reject(reason));
                        }
                } catch (error) { 
                    if(fs.existsSync(pathVersion)){
                        fs.unlinkSync(pathVersion);
                        return this.loadRemoteVersion(versionString); 
                    }  else {
                        reject(error);
                    }
                }
            }
        );
    }
}

export class SolcCompiler {

    public nodeCompiler: NpmModuleCompilerLoader;
    public localCompiler: LocalPathCompilerLoader;
    public remoteCompiler: RemoteCompilerLoader;
    public embeddedCompiler: EmbeddedCompilerLoader;
    public rootPath: string;
    public selectedCompiler: compilerType;

    constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.nodeCompiler = new NpmModuleCompilerLoader();
        this.localCompiler = new LocalPathCompilerLoader();
        this.remoteCompiler = new RemoteCompilerLoader();
        this.embeddedCompiler = new EmbeddedCompilerLoader();
        this.selectedCompiler = compilerType.embedded;
    }
    
    public setSolcCache(solcCachePath: string): void {
        this.remoteCompiler.setSolcCache(solcCachePath);
    }

    public isRootPathSet(): boolean {
        return typeof this.rootPath !== 'undefined' && this.rootPath !== null;
    }

    public initialisedAlready(setting:string, compiler: compilerType): boolean {
        if(compiler == compilerType.remote) {
            return this.remoteCompiler.isInitialisedAlready(setting);
        }

        if(compiler == compilerType.localFile) {
            return this.localCompiler.isInitialisedAlready(setting);
        }

        if(compiler == compilerType.localNodeModule) {
            return this.nodeCompiler.isInitialisedAlready(setting);
        }

        if(compiler == compilerType.embedded) {
            return this.embeddedCompiler.isInitialisedAlready();
        }
    }

    public initialiseAllCompilerSettings(remoteVersionSetting:string, localPathSetting:string, nodeModuleSetting:string, selectedCompiler:compilerType){
        this.nodeCompiler.init(this.rootPath, nodeModuleSetting);
        this.remoteCompiler.init(remoteVersionSetting);
        this.localCompiler.init(localPathSetting);
        this.embeddedCompiler.init();
        this.selectedCompiler = selectedCompiler;
    }
    
    public initialiseSelectedCompiler(): Promise<void> {
        return this.getCompiler().initialiseCompiler();
    }

    public initialiseCompiler(selectedCompiler: compilerType): Promise<void> {
        return this.getCompiler(selectedCompiler).initialiseCompiler();
    }

    public compile(contracts: any, selectedCompiler: compilerType = null): any {
        let compiler = this.getCompiler(selectedCompiler);
        return compiler.localSolc.compile(contracts);
    }

    public getCompiler(selectedCompiler: compilerType = null): SolcCompilerLoader {
        if(selectedCompiler == null) {
            selectedCompiler = this.selectedCompiler;
        }
        switch (selectedCompiler) {
            case compilerType.embedded:
                return this.embeddedCompiler;
            case compilerType.localNodeModule:
                return this.nodeCompiler;       
            case compilerType.localFile:
                return this.localCompiler;
            case compilerType.remote:
                return this.remoteCompiler;
            default:
                throw new Error("Invalid compiler");
        }
    }

    public compileSolidityDocumentAndGetDiagnosticErrors(filePath: string, documentText: string,
        packageDefaultDependenciesDirectory: string, packageDefaultDependenciesContractsDirectory: string, selectedCompiler: compilerType = null) {
            if(selectedCompiler == null) {
                selectedCompiler = this.selectedCompiler;
            }
        if (this.isRootPathSet()) {
            const contracts = new ContractCollection();
            contracts.addContractAndResolveImports(
                filePath,
                documentText,
                initialiseProject(this.rootPath, packageDefaultDependenciesDirectory, packageDefaultDependenciesContractsDirectory));
            const contractsForCompilation = contracts.getDefaultContractsForCompilationDiagnostics();
            contractsForCompilation.settings = null;
            const outputString = this.compile(JSON.stringify(contractsForCompilation), selectedCompiler);
            const output = JSON.parse(outputString);
            if (output.errors) {
                return output
                    .errors
                    .map(error => errorToDiagnostic(error));
            }
        } else {
            const contract = {};
            contract[filePath] = documentText;
            const output = this.compile({ sources: contract });
            if (output.errors) {
                return output.errors.map((error) => errorToDiagnostic(error));
            }
        }
        return [];
    }

}

