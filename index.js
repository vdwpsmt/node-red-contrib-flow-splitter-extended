const path = require('path')
const fs = require('fs')
const manager = require('flows-file-manager')
const eol = require('eol')
const yaml = require('js-yaml')
const functionsTemplatesHandler = require('./functions-templates-handler')

/**
 * Here we define some types to allow the IDE to provide us autocompletion.
 * Some are documented directly by the nodered team but some are not.
 * 
 * That's why we also made an `index.d.ts` for undocumented types we need to manipulate.
 * Those are defined by analysing the nodered code and some logging of those objects.
 * In this regard, the types defined by ourselves might be incomplete.
 * 
 * @typedef {import('./index').noderedEvent.FlowStartedEvent} FlowStartedEventType
 * @typedef {import('./index').noderedEvent.ExtendedNodeDef} ExtendedNodeDef
 * @typedef {import("node-red").NodeRedApp} REDType
 */

/**
 * Exposing the RED runtime globally to avoid passing it in every functions.
 * @type {REDType}
 */
let RED

const splitCfgFilename = '.config.flow-splitter.json'
const DEFAULT_CFG = {
    fileFormat: 'yaml',
    destinationFolder: 'src',
    tabsOrder: [],
    monolithFilename: "flows.json",
    extractFunctionsTemplates: true
}

/**
 * Write splitter configuration to disk
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function writeSplitterConfig(cfg, projectPath) {
    RED.log.info("[node-red-contrib-flow-splitter-extended] Writing new config")
    try {
        const splitterCfgToWrite = JSON.parse(JSON.stringify(cfg))
        delete splitterCfgToWrite.monolithFilename
        fs.writeFileSync(path.join(projectPath, splitCfgFilename), eol.auto(JSON.stringify(splitterCfgToWrite, null, 2)))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write splitter config '${splitCfgFilename}': ${error}`)
    }
}

/**
 * Get the project path (handles both project mode and non-project mode)
 * @returns {string} Project path
 */
function getProjectPath() {
    const userDir = RED.settings.userDir
    const projectsConfigFile = path.join(userDir, '.config.projects.json')

    if (fs.existsSync(projectsConfigFile)) {
        const nrProjectsCfg = JSON.parse(fs.readFileSync(projectsConfigFile))
        return path.join(userDir, 'projects', nrProjectsCfg.activeProject)
    }
    return userDir
}

/**
 * Load splitter configuration from disk
 * @param {string} projectPath - Path to the project
 * @returns {object} Splitter configuration
 */
function loadSplitterConfig(projectPath) {
    let cfg = { ...DEFAULT_CFG }
    cfg.monolithFilename = RED.settings.flowFile || 'flows.json'
    
    const configPath = path.join(projectPath, splitCfgFilename)
    if (fs.existsSync(configPath)) {
        const loadedCfg = JSON.parse(fs.readFileSync(configPath))
        cfg = { ...cfg, ...loadedCfg }
        cfg.monolithFilename = loadedCfg.monolithFilename || RED.settings.flowFile || 'flows.json'
    }
    return cfg
}

/**
 * Get private RED instance to access internal APIs
 * @returns {REDType} Private RED instance
 */
function getPrivateRED() {
    for (const child of require.main.children) {
        if (child.filename.endsWith('red.js')) {
            return require(child.filename)
        }
    }
    return require('node-red')
}

/**
 * Extract functions and templates from split flow files
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function extractFunctionsTemplatesFromSplitFiles(cfg, projectPath) {
    if (cfg.extractFunctionsTemplates === false) {
        return
    }

    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabsDir = path.join(srcDir, 'tabs')
    const subflowsDir = path.join(srcDir, 'subflows')

    RED.log.info("[node-red-contrib-flow-splitter-extended] Extracting functions and templates...")

    processFlowDirectory(tabsDir, cfg.fileFormat, 'tab')
    processFlowDirectory(subflowsDir, cfg.fileFormat, 'subflow')
}

/**
 * Process a directory of flow files to extract functions/templates
 * @param {string} dir - Directory to process
 * @param {string} fileFormat - File format (yaml or json)
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function processFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = fileFormat === 'yaml' ? '.yaml' : '.json'
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat === 'yaml') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            const flowNodes = Array.isArray(flowData) ? flowData : [flowData]
            functionsTemplatesHandler.extractFunctionsAndTemplates(flowNodes, flowName, dir, RED)

        } catch (error) {
            RED.log.warn(`[node-red-contrib-flow-splitter-extended] Error processing ${flowType} ${flowName}: ${error.message}`)
        }
    })
}

/**
 * Collect functions and templates back into split flow files before rebuilding monolith
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function collectFunctionsTemplatesIntoSplitFiles(cfg, projectPath) {
    if (cfg.extractFunctionsTemplates === false) {
        return
    }

    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabsDir = path.join(srcDir, 'tabs')
    const subflowsDir = path.join(srcDir, 'subflows')

    RED.log.info("[node-red-contrib-flow-splitter-extended] Collecting functions and templates...")

    collectFromFlowDirectory(tabsDir, cfg.fileFormat, 'tab')
    collectFromFlowDirectory(subflowsDir, cfg.fileFormat, 'subflow')
}

/**
 * Process a directory of flow files to collect functions/templates
 * @param {string} dir - Directory to process
 * @param {string} fileFormat - File format (yaml or json)
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function collectFromFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = fileFormat === 'yaml' ? '.yaml' : '.json'
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat === 'yaml') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            let flowNodes = Array.isArray(flowData) ? flowData : [flowData]
            flowNodes = functionsTemplatesHandler.collectFunctionsAndTemplates(flowNodes, flowName, dir, RED)

            if (fileFormat === 'yaml') {
                const yamlContent = yaml.dump(flowNodes, {
                    indent: 2,
                    lineWidth: -1,
                    noRefs: true,
                    sortKeys: false
                })
                fs.writeFileSync(filePath, eol.auto(yamlContent), 'utf8')
            } else {
                fs.writeFileSync(filePath, eol.auto(JSON.stringify(flowNodes, null, 2)), 'utf8')
            }

        } catch (error) {
            RED.log.warn(`[node-red-contrib-flow-splitter-extended] Error collecting ${flowType} ${flowName}: ${error.message}`)
        }
    })
}

/**
 * Manual reload endpoint handler
 * Collects functions/templates from files and reloads flows
 */
async function manualReload(req, res) {
    try {
        RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload triggered")

        const projectPath = getProjectPath()
        const cfg = loadSplitterConfig(projectPath)

        collectFunctionsTemplatesIntoSplitFiles(cfg, projectPath)

        const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath)

        if (!flowSet) {
            RED.log.error("[node-red-contrib-flow-splitter-extended] Cannot build FlowSet from source tree files")
            return res.status(500).json({ 
                success: false, 
                error: "Cannot build FlowSet from source tree files" 
            })
        }

        manager.constructMonolithFileFromFlowSet(flowSet, cfg, projectPath, false)

        const PRIVATE_RED = getPrivateRED()
        await PRIVATE_RED.nodes.loadFlows(true)

        RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload completed successfully")
        
        res.json({ 
            success: true, 
            message: "Functions and templates reloaded successfully"
        })

    } catch (error) {
        RED.log.error(`[node-red-contrib-flow-splitter-extended] Manual reload failed: ${error.message}`)
        res.status(500).json({ 
            success: false, 
            error: error.message 
        })
    }
}

/**
 * Main function executed on each flow restart
 * @param {FlowStartedEventType} flowEventData
 * @returns {void}
 */
async function onFlowReload(flowEventData) {
    RED.log.info("[node-red-contrib-flow-splitter-extended] Flow restart event")

    const projectPath = getProjectPath()
    const cfg = loadSplitterConfig(projectPath)

    if (flowEventData.config.flows.length === 0) {
        // The flow file does not exist or is empty - rebuild from split files
        RED.log.info("[node-red-contrib-flow-splitter-extended] Rebuilding monolith file from source files")
        
        collectFunctionsTemplatesIntoSplitFiles(cfg, projectPath)
        
        const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath)

        if (!flowSet) {
            RED.log.error("[node-red-contrib-flow-splitter-extended] Cannot build FlowSet from source tree files")
            return
        }

        const updatedCfg = manager.constructMonolithFileFromFlowSet(flowSet, cfg, projectPath, false)
        writeSplitterConfig(updatedCfg, projectPath)

        const PRIVATE_RED = getPrivateRED()

        RED.log.info("[node-red-contrib-flow-splitter-extended] Stopping and loading nodes")

        PRIVATE_RED.nodes.loadFlows(true).then(function () {
            RED.log.info("[node-red-contrib-flow-splitter-extended] Flows are rebuilt and available")
        })
        return
    }

    // Flows exist - split into source files
    const flowSet = manager.constructFlowSetFromMonolithObject(flowEventData.config.flows)

    const updatedCfg = manager.constructTreeFilesFromFlowSet(flowSet, cfg, projectPath)
    writeSplitterConfig(updatedCfg, projectPath)

    extractFunctionsTemplatesFromSplitFiles(updatedCfg, projectPath)

    try {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
        await delay(150) // Wait for Node-RED to create the flowFile before erasing it
        fs.unlinkSync(path.join(projectPath, RED.settings.flowFile))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Cannot erase file '${RED.settings.flowFile}': ${error.message}`)
    }
}

/**
 * @param {REDType} REDRuntime 
 */
module.exports = function (REDRuntime) {
    RED = REDRuntime

    // Register the plugin for Node-RED
    RED.plugins.registerPlugin("node-red-contrib-flow-splitter-extended", {
        type: "exotec-deploy-plugins",
        onadd: function () {
            RED.log.info("[node-red-contrib-flow-splitter-extended] Initialized plugin successfully")
        }
    })

    // Register HTTP endpoint for manual reload
    RED.httpAdmin.post("/flow-splitter/reload", manualReload)
    RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload endpoint registered at POST /flow-splitter/reload")

    // Code to launch on every restart of the flows = boot or deploy event
    RED.events.on('flows:started', onFlowReload)
}
