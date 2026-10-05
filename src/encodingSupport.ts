import { UriScheme } from "./shared/identifiers"
import { errorMessage } from "./shared/guards"
import { ConfigurationSection, LanguageId, SettingKey } from "./shared/identifiers"
import type * as VSCode from "vscode"
import { OutputChannel } from "vscode"

const STATE_KEY = "pascalAtlas.encoding.managedSettings.v1"
const DPROJ_LANGUAGE_ID = LanguageId.Project
const DELPHI_LANGUAGE_IDS = Object.freeze([
  LanguageId.Pascal,
  LanguageId.ObjectPascal,
  DPROJ_LANGUAGE_ID,
])
const DPROJ_ASSOCIATIONS = Object.freeze(["*.dproj", "*.DPROJ"])

/**
 * Record both presence and value of a setting so restoration can distinguish an unset
 * override from an explicit value.
 */
function valueSlot<T>(value: T | undefined): ValueSlot<T> {
  return value === undefined ? { exists: false } : { exists: true, value }
}

/**
 * Read the selected global/workspace and language-override slot from an inspected
 * configuration without falling through to inherited values.
 */
function targetValue<T>(
  inspected: ConfigurationInspection<T> | undefined,
  target: string,
  languageOverride: boolean,
): T | undefined {
  if (!inspected) return undefined
  if (target === "workspace") {
    return languageOverride
      ? inspected.workspaceLanguageValue
      : inspected.workspaceValue
  }
  return languageOverride ? inspected.globalLanguageValue : inspected.globalValue
}

/**
 * Choose workspace scope when a folder is open, otherwise global scope, and return the
 * matching VS Code update target.
 */
function configurationTarget(vscode: EncodingApi): EncodingTarget {
  return vscode.workspace.workspaceFolders?.length
    ? { id: "workspace", value: vscode.ConfigurationTarget.Workspace }
    : { id: "global", value: vscode.ConfigurationTarget.Global }
}

/**
 * Build a language-scoped configuration context using the first workspace URI when one
 * exists.
 */
function configurationScope(vscode: EncodingApi, languageId: string) {
  return { uri: vscode.workspace.workspaceFolders?.[0]?.uri, languageId }
}

/**
 * Normalize supported UTF-8 XML spellings to VS Code encoding IDs; return undefined
 * for unsupported declarations.
 */
function normalizeXmlEncoding(value: string | undefined) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]/g, "-")
  const encodings: Record<string, string> = {
    "utf-8": "utf8",
    utf8: "utf8",
    "utf-8-bom": "utf8bom",
    utf8bom: "utf8bom",
  }
  return encodings[normalized]
}

/**
 * Restrict configured fallback encodings to UTF-8 with or without BOM, using the
 * supported fallback for other values.
 */
function supportedEncoding(value: string, fallback = "utf8") {
  if (value === "utf8" || value === "utf8bom") return value
  return fallback === "utf8bom" ? "utf8bom" : "utf8"
}

/**
 * Inspect an ASCII-safe prefix of a byte buffer for an XML encoding declaration
 * without decoding arbitrary document contents first.
 */
function declaredXmlEncoding(bytes: Uint8Array) {
  if (!bytes?.length) return undefined
  const prefix = Array.from(
    bytes.subarray(0, Math.min(bytes.length, 1024)),
    /** Create the next initialized entry used by declared xml encoding. */ (byte) =>
      byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : " ",
  ).join("")
  const match = prefix.match(/<\?xml\b[^>]*\bencoding\s*=\s*['"]([^'"]+)['"]/i)
  return normalizeXmlEncoding(match?.[1])
}

/**
 * Detect the UTF-8 byte-order mark, returning undefined for missing, short, or
 * unmarked buffers.
 */
function bomEncoding(bytes: Uint8Array | undefined) {
  if (!bytes || bytes.length < 3) return undefined
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8bom"
  return undefined
}

/**
 * Determine whether a present byte buffer contains only ASCII bytes, where encoding
 * detection cannot disambiguate UTF-8 BOM policy.
 */
function isAscii(bytes: Uint8Array | undefined) {
  return (
    bytes !== undefined &&
    bytes.every(
      /** Detect an all-ASCII buffer before trying multibyte encoding heuristics. */ (
        byte,
      ) => byte < 0x80,
    )
  )
}

/**
 * Validate UTF-8 bytes with a fatal decoder rather than silently replacing malformed
 * sequences.
 */
function isValidUtf8(bytes: Uint8Array | undefined) {
  if (!bytes) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Decode a present source/compiler byte buffer as UTF-8 text, returning an empty
 * string for absent or empty input.
 */
function decodePascalBytes(bytes: Uint8Array | undefined) {
  if (!bytes?.length) return ""
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Retain already-decoded process output or decode a byte buffer through the Pascal
 * text decoder.
 */
function decodeProcessOutput(value: string | Uint8Array) {
  if (typeof value === "string") return value
  return decodePascalBytes(value)
}

/**
 * Choose a supported encoding using an explicit declaration, BOM, ASCII fallback, then
 * UTF-8 validity in that precedence order.
 */
function reconciledEncoding(
  bytes: Uint8Array,
  fallback: string,
  explicitEncoding?: string,
) {
  const explicit = normalizeXmlEncoding(explicitEncoding)
  if (explicit) return explicit
  const bom = bomEncoding(bytes)
  if (bom) return bom
  // ASCII bytes fit both supported UTF-8 policies; preserve the configured BOM preference when bytes cannot distinguish them.
  if (isAscii(bytes)) return supportedEncoding(fallback)
  return isValidUtf8(bytes) ? "utf8" : supportedEncoding(fallback)
}

/** Recognize a file-backed Delphi project document using its URI or filename suffix. */
function isDprojDocument(document: EncodingDocument) {
  return (
    document?.uri?.scheme === UriScheme.File &&
    /\.dproj$/i.test(document.uri.fsPath || document.fileName || "")
  )
}

interface ConfigurationInspection<T> {
  workspaceLanguageValue?: T
  workspaceValue?: T
  globalLanguageValue?: T
  globalValue?: T
}
type ValueSlot<T> = { exists: false } | { exists: true; value: T }
interface EncodingTarget {
  id: "workspace" | "global"
  value: VSCode.ConfigurationTarget
}
type EncodingDocument = Pick<
  VSCode.TextDocument,
  "uri" | "fileName" | "isDirty" | "isClosed"
> & { encoding?: string }
interface EncodingApi {
  ConfigurationTarget: Pick<typeof VSCode.ConfigurationTarget, "Workspace" | "Global">
  workspace: Pick<
    typeof VSCode.workspace,
    | "workspaceFolders"
    | "getConfiguration"
    | "onDidChangeConfiguration"
    | "onDidOpenTextDocument"
    | "textDocuments"
    | "fs"
  > & {
    /**
     * Open a document with an explicit encoding instead of relying on automatic
     * detection.
     */
    openTextDocument(
      uri: VSCode.Uri,
      options: { encoding: string },
    ): Thenable<EncodingDocument>
  }
}
interface PreviousLanguageSettings {
  encoding: ValueSlot<string>
  autoGuessEncoding?: ValueSlot<boolean>
}
interface EncodingState {
  target: string
  previous: {
    encoding: ValueSlot<string>
    autoGuessEncoding?: ValueSlot<boolean>
    associations: Record<string, ValueSlot<string>>
    languages: Record<string, PreviousLanguageSettings>
  }
  applied?: { delphiEncoding: string; otherEncoding: string }
}
class EncodingPolicy {
  context: Pick<
    VSCode.ExtensionContext,
    "subscriptions" | "workspaceState" | "globalState"
  >
  output: Pick<OutputChannel, "appendLine">
  vscode: EncodingApi
  applying
  reopening: Set<string>

  /**
   * Create an encoding policy with injected VS Code bindings, serialized settings
   * updates, and a guard against recursive reopen operations.
   */
  constructor(
    context: Pick<
      VSCode.ExtensionContext,
      "subscriptions" | "workspaceState" | "globalState"
    >,
    output: Pick<OutputChannel, "appendLine">,
    vscodeApi?: EncodingApi,
  ) {
    this.context = context
    this.output = output
    this.vscode = vscodeApi || require("vscode")
    this.applying = Promise.resolve()
    this.reopening = new Set()
  }

  /**
   * Subscribe to encoding settings and document-open changes, then reconcile existing
   * open documents after initial policy application.
   */
  register() {
    const vscode = this.vscode
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(
        /**
         * Resynchronize encoding policy when its enablement or encoding settings change.
         */ (event) => {
          if (
            event.affectsConfiguration("pascalAtlas.encoding") ||
            event.affectsConfiguration("pascalAtlas.enabled")
          )
            void this.sync()
        },
      ),
      vscode.workspace.onDidOpenTextDocument(
        /**
         * Reconcile the opened document after any pending encoding configuration update
         * completes.
         */ (document) => {
          void this.applying.then(
            /** Reconcile encoding after the document-open notification resolves. */ () =>
              this.reconcileOpenDocument(document),
          )
        },
      ),
    )
    void this.sync().then(
      /**
       * Reconcile all open documents after initial configuration synchronization
       * completes.
       */ () =>
        Promise.all(
          (vscode.workspace.textDocuments || []).map(
            /**
             * Reconcile encoding policy for each document already open at registration
             * time.
             */ (document) => this.reconcileOpenDocument(document),
          ),
        ),
    )
  }

  /**
   * Serialize policy changes through one promise chain and log failures so later
   * configuration updates remain usable.
   */
  sync() {
    this.applying = this.applying
      .then(
        /** Apply encoding configuration after the previous synchronization finishes. */ () =>
          this.applyCurrentConfiguration(),
      )
      .catch(
        /**
         * Log encoding configuration failures while leaving the policy available for
         * future updates.
         */ (error) =>
          this.output?.appendLine(
            `Encoding policy update failed: ${error.stack || error.message}`,
          ),
      )
    return this.applying
  }

  /**
   * Apply managed global/language encoding defaults and DPROJ associations, retaining
   * prior settings for restoration and migrating older auto-guess overrides.
   */
  async applyCurrentConfiguration() {
    const vscode = this.vscode
    const pa = vscode.workspace.getConfiguration(ConfigurationSection)
    const enabled =
      pa.get(SettingKey.Enabled, true) && pa.get(SettingKey.EncodingEnabled, true)
    if (!enabled) return this.restore()

    const delphiEncoding = supportedEncoding(
      pa.get(SettingKey.EncodingDelphiDefault, "utf8"),
    )
    const otherEncoding = supportedEncoding(
      pa.get(SettingKey.EncodingOtherDefault, "utf8"),
    )
    const target = configurationTarget(vscode)
    const store =
      target.id === "workspace" ? this.context.workspaceState : this.context.globalState
    let state = store.get<EncodingState>(STATE_KEY)
    if (!state || state.target !== target.id) state = this.capture(target)

    const globalFiles = vscode.workspace.getConfiguration("files")
    const previousAutoGuess = state.previous?.autoGuessEncoding
    const previousLanguageAutoGuess = Object.values(
      state.previous?.languages || {},
    ).some(
      /** Detect whether any language override enables automatic encoding guesses. */ (
        value,
      ) => value.autoGuessEncoding,
    )
    if (previousAutoGuess || previousLanguageAutoGuess) {
      await globalFiles.update(
        "autoGuessEncoding",
        previousAutoGuess?.exists ? previousAutoGuess.value : undefined,
        target.value,
        false,
      )
      for (const languageId of DELPHI_LANGUAGE_IDS) {
        const previous = state.previous.languages?.[languageId]?.autoGuessEncoding
        const files = vscode.workspace.getConfiguration(
          "files",
          configurationScope(vscode, languageId),
        )
        await files.update(
          "autoGuessEncoding",
          previous?.exists ? previous.value : undefined,
          target.value,
          true,
        )
      }
      delete state.previous.autoGuessEncoding
      for (const previous of Object.values(state.previous.languages || {}))
        delete previous.autoGuessEncoding
    }
    await globalFiles.update("encoding", otherEncoding, target.value, false)
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration(
        "files",
        configurationScope(vscode, languageId),
      )
      await files.update("encoding", delphiEncoding, target.value, true)
    }

    const associations = {
      ...targetValue(
        globalFiles.inspect<Record<string, string>>("associations"),
        target.id,
        false,
      ),
    }
    for (const pattern of DPROJ_ASSOCIATIONS) associations[pattern] = DPROJ_LANGUAGE_ID
    await globalFiles.update("associations", associations, target.value, false)
    state.applied = { delphiEncoding, otherEncoding }
    await store.update(STATE_KEY, state)
    this.output?.appendLine(
      `Encoding policy active (${target.id}): Delphi fallback=${delphiEncoding}, ` +
        `other fallback=${otherEncoding}.`,
    )
  }

  /**
   * Snapshot the explicitly configured encoding and managed association slots at the
   * chosen settings target before applying policy overrides.
   */
  capture(target: EncodingTarget): EncodingState {
    const vscode = this.vscode
    const globalFiles = vscode.workspace.getConfiguration("files")
    const languages: Record<string, PreviousLanguageSettings> = {}
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration(
        "files",
        configurationScope(vscode, languageId),
      )
      languages[languageId] = {
        encoding: valueSlot(
          targetValue(files.inspect<string>("encoding"), target.id, true),
        ),
      }
    }
    const associationValues =
      targetValue(
        globalFiles.inspect<Record<string, string>>("associations"),
        target.id,
        false,
      ) || {}
    return {
      target: target.id,
      previous: {
        encoding: valueSlot(
          targetValue(globalFiles.inspect<string>("encoding"), target.id, false),
        ),
        associations: Object.fromEntries(
          DPROJ_ASSOCIATIONS.map(
            /**
             * Capture prior file association slots so ownership can be restored safely.
             */ (pattern) => [pattern, valueSlot(associationValues[pattern])],
          ),
        ),
        languages,
      },
    }
  }

  /**
   * Restore captured encoding/association overrides for the current target, retain
   * user-replaced association values, and clear the managed policy state.
   */
  async restore() {
    const vscode = this.vscode
    const target = configurationTarget(vscode)
    const store =
      target.id === "workspace" ? this.context.workspaceState : this.context.globalState
    const state = store.get<EncodingState>(STATE_KEY)
    if (!state || state.target !== target.id) return
    const globalFiles = vscode.workspace.getConfiguration("files")
    await globalFiles.update(
      "encoding",
      state.previous.encoding.exists ? state.previous.encoding.value : undefined,
      target.value,
      false,
    )
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const previous = state.previous.languages[languageId]
      const files = vscode.workspace.getConfiguration(
        "files",
        configurationScope(vscode, languageId),
      )
      await files.update(
        "encoding",
        previous.encoding.exists ? previous.encoding.value : undefined,
        target.value,
        true,
      )
    }
    const associations = {
      ...targetValue(
        globalFiles.inspect<Record<string, string>>("associations"),
        target.id,
        false,
      ),
    }
    for (const pattern of DPROJ_ASSOCIATIONS) {
      const previous = state.previous.associations[pattern]
      // Restore a captured override; otherwise delete only the association still owned by this policy.
      if (previous.exists) associations[pattern] = previous.value
      else if (associations[pattern] === DPROJ_LANGUAGE_ID) delete associations[pattern]
    }
    await globalFiles.update(
      "associations",
      Object.keys(associations).length ? associations : undefined,
      target.value,
      false,
    )
    await store.update(STATE_KEY, undefined)
    this.output?.appendLine(
      `Encoding policy disabled; restored previous ${target.id} encoding settings.`,
    )
  }

  /**
   * Reopen a clean file-backed DPROJ document with its supported XML-declared
   * encoding, preventing reopen loops and logging I/O failures.
   */
  async honorDprojDeclaration(document: EncodingDocument) {
    if (
      !isDprojDocument(document) ||
      document.isDirty ||
      typeof document.encoding !== "string"
    )
      return
    const key = document.uri.toString()
    if (this.reopening.has(key)) return
    const pa = this.vscode.workspace.getConfiguration(
      ConfigurationSection,
      document.uri,
    )
    if (
      !pa.get(SettingKey.Enabled, true) ||
      !pa.get(SettingKey.EncodingEnabled, true) ||
      !pa.get(SettingKey.EncodingRespectDprojDeclaration, true)
    )
      return
    try {
      const bytes = await this.vscode.workspace.fs.readFile(document.uri)
      const declared = declaredXmlEncoding(bytes)
      if (!declared || declared === document.encoding) return
      // Reopening emits another document-open event, so the URI guard prevents the policy from recursively reopening the same document.
      this.reopening.add(key)
      await this.vscode.workspace.openTextDocument(document.uri, { encoding: declared })
      this.output?.appendLine(
        `Reopened ${document.uri.fsPath} as ${declared} to honor its XML encoding declaration.`,
      )
    } catch (error) {
      this.output?.appendLine(
        `Could not honor DPROJ encoding declaration: ${errorMessage(error)}`,
      )
    } finally {
      this.reopening.delete(key)
    }
  }

  /**
   * Inspect a clean file document and reopen it only when enabled detection identifies
   * a supported encoding different from its current decoder.
   */
  async reconcileOpenDocument(document: EncodingDocument) {
    if (!document || document.uri?.scheme !== UriScheme.File || document.isDirty) return
    const pa = this.vscode.workspace.getConfiguration(
      ConfigurationSection,
      document.uri,
    )
    if (!pa.get(SettingKey.Enabled, true) || !pa.get(SettingKey.EncodingEnabled, true))
      return
    if (!pa.get(SettingKey.EncodingDetectExisting, true)) return
    if (
      isDprojDocument(document) &&
      pa.get(SettingKey.EncodingRespectDprojDeclaration, true)
    ) {
      await this.honorDprojDeclaration(document)
      if (document.isClosed || document.isDirty) return
    }
    if (typeof document.encoding !== "string") return
    const fileName = document.uri.fsPath || document.fileName || ""
    const delphi = /\.(?:pas|dpr|dpk|dproj)$/i.test(fileName)
    const fallback = supportedEncoding(
      pa.get(
        delphi ? SettingKey.EncodingDelphiDefault : SettingKey.EncodingOtherDefault,
        "utf8",
      ),
    )
    const key = document.uri.toString()
    if (this.reopening.has(key)) return
    try {
      const bytes = await this.vscode.workspace.fs.readFile(document.uri)
      const explicit =
        bomEncoding(bytes) ||
        (isDprojDocument(document) ? declaredXmlEncoding(bytes) : undefined)
      const desired = reconciledEncoding(bytes, fallback, explicit)
      if (!desired || desired === document.encoding) return
      this.reopening.add(key)
      await this.vscode.workspace.openTextDocument(document.uri, { encoding: desired })
      this.output?.appendLine(
        `Reopened ${document.uri.fsPath} as ${desired} after encoding-policy startup reconciliation.`,
      )
    } catch (error) {
      this.output?.appendLine(
        `Could not reconcile document encoding: ${errorMessage(error)}`,
      )
    } finally {
      this.reopening.delete(key)
    }
  }
}

/**
 * Create, register, and return the document encoding policy so the caller can share
 * its lifecycle.
 */
function registerEncodingSupport(
  context: Pick<
    VSCode.ExtensionContext,
    "subscriptions" | "workspaceState" | "globalState"
  >,
  output: OutputChannel,
  vscodeApi?: EncodingApi,
) {
  const policy = new EncodingPolicy(context, output, vscodeApi)
  policy.register()
  return policy
}

export {
  DELPHI_LANGUAGE_IDS,
  DPROJ_LANGUAGE_ID,
  EncodingPolicy,
  bomEncoding,
  decodePascalBytes,
  decodeProcessOutput,
  declaredXmlEncoding,
  isAscii,
  isValidUtf8,
  normalizeXmlEncoding,
  reconciledEncoding,
  registerEncodingSupport,
  supportedEncoding,
}
