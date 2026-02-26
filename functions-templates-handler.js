const path = require('path')
const fs = require('fs-extra')

/**
 * Functions and Templates nodes Handler
 * Extracts function and ui-template node code into separate files
 * and restores them back when rebuilding flows
 */

/**
 * Extract functions and templates from flow nodes into separate files
 * @param {Array} flowNodes - Array of nodes from a tab or subflow
 * @param {string} flowName - Name of the tab or subflow
 * @param {string} flowDir - Directory where the flow file is stored
 * @param {object} RED - Node-RED runtime
 */
function extractFunctionsAndTemplates(flowNodes, flowName, flowDir, RED) {
    if (!flowNodes || flowNodes.length === 0) return

    const extractedDir = path.join(flowDir, flowName)
    
    // Delete entire extracted directory to ensure fresh state
    if (fs.existsSync(extractedDir)) {
        fs.removeSync(extractedDir)
    }
    
    const manifest = {}
    const fileNames = []
    let count = 0

    flowNodes.forEach((node) => {
        const id = node.id
        const type = node.type

        let name

        if (type === 'function') {
            name = node.name || 'unnamed-function'
        } else if (type === 'ui-template') {
            name = node.name || 'unnamed-template'
        } else {
            return
        }

        const sanitizedName = name.replace(/[\/\\:*?"<>|]/g, '-')
        fileNames.push(sanitizedName)
        const nameCount = fileNames.filter((n) => n === sanitizedName).length

        let fileName
        if (nameCount > 1) {
            fileName = `${sanitizedName}(${nameCount})`
        } else {
            fileName = sanitizedName
        }

        // Detect if it's a Vue template or a function
        const hasTemplate = node.format?.trim().indexOf('<template>') !== -1 ?? false
        const hasScript = node.format?.trim().indexOf('<script>') !== -1 ?? false
        const isVue = (typeof node.format === 'string' && (hasTemplate || hasScript))
        const isFun = (
            (typeof node.func === 'string' && node.func.trim().length > 0) ||
            (typeof node.initialize === 'string' && node.initialize.trim().length > 0) ||
            (typeof node.finalize === 'string' && node.finalize.trim().length > 0)
        ) && isVue === false

        let code = isVue ? node.format : node.func
        let initialize = isFun ? node.initialize : undefined
        let finalize = isFun ? node.finalize : undefined
        let info = node.info ?? undefined

        // Clean up empty values
        if ((code ?? '').trim().length === 0) code = undefined
        if ((initialize ?? '').trim().length === 0) initialize = undefined
        if ((finalize ?? '').trim().length === 0) finalize = undefined
        if ((info ?? '').trim().length === 0) info = undefined

        if (isVue || isFun) {
            // Ensure output directory exists
            if (!fs.existsSync(extractedDir)) {
                fs.mkdirSync(extractedDir, { recursive: true })
            }

            count++

            const baseName = fileName
            const codeName = `${baseName}.${isVue ? 'vue' : 'js'}`
            const initializeName = `${baseName}.initialize.js`
            const finalizeName = `${baseName}.finalize.js`
            const infoName = `${baseName}.info.md`

            const codeFile = path.join(extractedDir, codeName)
            const initializeFile = path.join(extractedDir, initializeName)
            const finalizeFile = path.join(extractedDir, finalizeName)
            const infoFile = path.join(extractedDir, infoName)

            // Write files
            if (code != null) {
                fs.writeFileSync(codeFile, code, 'utf8')
            }
            if (initialize != null) {
                fs.writeFileSync(initializeFile, initialize, 'utf8')
            }
            if (finalize != null) {
                fs.writeFileSync(finalizeFile, finalize, 'utf8')
            }
            if (info != null) {
                fs.writeFileSync(infoFile, info, 'utf8')
            }

            // Store in manifest
            manifest[id] = {
                nodeId: id,
                name,
                sanitizedName,
                fileName,
                isVue,
                isFun,
                hasCode: code != null,
                hasInitialize: initialize != null,
                hasFinalize: finalize != null,
                hasInfo: info != null
            }
        }
    })

    // Save manifest if we extracted anything
    if (count > 0) {
        const manifestFile = path.join(extractedDir, '.manifest.json')
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
        
        RED.log.info(`[node-red-contrib-flow-splitter] Extracted ${count} functions/templates for "${flowName}"`)
    }
}

/**
 * Restore functions and templates from separate files back into flow nodes
 * @param {Array} flowNodes - Array of nodes from a tab or subflow
 * @param {string} flowName - Name of the tab or subflow
 * @param {string} flowDir - Directory where the flow file is stored
 * @param {object} RED - Node-RED runtime
 * @returns {Array} - Updated flow nodes
 */
function restoreFunctionsAndTemplates(flowNodes, flowName, flowDir, RED) {
    if (!flowNodes || flowNodes.length === 0) return flowNodes

    const extractedDir = path.join(flowDir, flowName)
    const manifestFile = path.join(extractedDir, '.manifest.json')

    // Check if manifest exists
    if (!fs.existsSync(manifestFile)) {
        return flowNodes
    }

    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter] Could not read manifest for "${flowName}": ${error.message}`)
        return flowNodes
    }

    let updatedCount = 0

    // Update nodes with content from files
    Object.keys(manifest).forEach((nodeId) => {
        const item = manifest[nodeId]
        const node = flowNodes.find(n => n.id === nodeId)

        if (!node) {
            RED.log.warn(`[node-red-contrib-flow-splitter] Node ${nodeId} not found in flow "${flowName}"`)
            return
        }

        const baseName = item.fileName
        const codeName = `${baseName}.${item.isVue ? 'vue' : 'js'}`
        const initializeName = `${baseName}.initialize.js`
        const finalizeName = `${baseName}.finalize.js`
        const infoName = `${baseName}.info.md`

        const codeFile = path.join(extractedDir, codeName)
        const initializeFile = path.join(extractedDir, initializeName)
        const finalizeFile = path.join(extractedDir, finalizeName)
        const infoFile = path.join(extractedDir, infoName)

        // Read and update code
        if (item.hasCode && fs.existsSync(codeFile)) {
            const content = fs.readFileSync(codeFile, 'utf8')
            if (item.isVue) {
                if (node.format !== content) {
                    node.format = content
                    node.func = content
                    updatedCount++
                }
            } else if (item.isFun) {
                if (node.func !== content) {
                    node.func = content
                    updatedCount++
                }
            }
        }

        // Read and update initialize
        if (item.hasInitialize && fs.existsSync(initializeFile)) {
            const content = fs.readFileSync(initializeFile, 'utf8')
            if (node.initialize !== content) {
                node.initialize = content
                updatedCount++
            }
        }

        // Read and update finalize
        if (item.hasFinalize && fs.existsSync(finalizeFile)) {
            const content = fs.readFileSync(finalizeFile, 'utf8')
            if (node.finalize !== content) {
                node.finalize = content
                updatedCount++
            }
        }

        // Read and update info
        if (item.hasInfo && fs.existsSync(infoFile)) {
            const content = fs.readFileSync(infoFile, 'utf8')
            if (node.info !== content) {
                node.info = content
                updatedCount++
            }
        }
    })

    if (updatedCount > 0) {
        RED.log.info(`[node-red-contrib-flow-splitter] Restored ${updatedCount} functions/templates for "${flowName}"`)
    }

    return flowNodes
}

module.exports = {
    extractFunctionsAndTemplates,
    restoreFunctionsAndTemplates
}
