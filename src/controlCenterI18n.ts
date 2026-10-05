"use strict"

const PAGE_GROUPS = Object.freeze([
  {
    id: "general",
    title: "General",
    sections: ["Interface language", "Master switch", "Dependencies and compatibility"],
  },
  {
    id: "editing",
    title: "Editing",
    sections: ["File encoding", "Explorer exclusions", "Missing uses"],
  },
  {
    id: "symbols",
    title: "Navigation & Symbols",
    sections: [
      "Symbol coloring",
      "Navigation and interfaces",
      "Class and routine navigator",
      "AI routine steps",
      "Completion and package symbols",
    ],
  },
  {
    id: "formatting",
    title: "Formatting",
    sections: ["Code formatting", "Formatting style"],
  },
  {
    id: "projects",
    title: "Projects & Files",
    sections: ["Delphi navigator · Project mode", "Projects and search paths"],
  },
  { id: "build", title: "Build & Debug", sections: ["Build and run"] },
  { id: "diagnostics", title: "Diagnostics", sections: ["Background diagnostics"] },
])

/**
 * Return the supported English UI language; the optional language argument is retained
 * for caller compatibility.
 */
function languageCode(_language?: string) {
  return "en"
}

/**
 * Attach a consolidated settings-page ID by section title while preserving each
 * section's original fields.
 */
function sectionsWithPages<T extends { title: string }>(
  sections: readonly T[],
  _language?: string,
) {
  // Page grouping is metadata only: spread the original section so descriptions, settings, and actions remain intact.
  return sections.map(
    /**
     * Preserve the section fields and add the settings page that contains its title.
     */ (section) => ({
      ...section,
      pageId: PAGE_GROUPS.find(
        /** Find the page whose section list contains this title. */ (page) =>
          page.sections.includes(section.title),
      )?.id,
    }),
  )
}

/**
 * Return English settings sections with their page assignments through the
 * compatibility localization entrypoint.
 */
function localizeSections<T extends { title: string }>(
  sections: readonly T[],
  _language?: string,
) {
  return sectionsWithPages(sections)
}

/**
 * Return fresh page descriptors with the English display label expected by the
 * settings renderer.
 */
function localizedPages(_language?: string) {
  return PAGE_GROUPS.map(
    /** Copy each page with the English label used by the settings renderer. */ (
      page,
    ) => ({ ...page, en: page.title }),
  )
}

export {
  PAGE_GROUPS,
  languageCode,
  localizeSections,
  localizedPages,
  sectionsWithPages,
}
