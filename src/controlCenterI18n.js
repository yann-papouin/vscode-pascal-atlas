'use strict';

const PAGE_GROUPS = Object.freeze([
  { id: 'general', title: 'General', sections: ['Interface language', 'Master switch', 'Dependencies and compatibility'] },
  { id: 'editing', title: 'Editing', sections: ['File encoding', 'Explorer exclusions', 'Missing uses'] },
  { id: 'symbols', title: 'Navigation & Symbols', sections: ['Symbol coloring', 'Navigation and interfaces', 'Class and routine navigator', 'AI routine steps', 'Completion and package symbols'] },
  { id: 'formatting', title: 'Formatting', sections: ['Code formatting', 'Formatting style'] },
  { id: 'projects', title: 'Projects & Files', sections: ['Delphi navigator · Project mode', 'Projects and search paths'] },
  { id: 'build', title: 'Build & Debug', sections: ['Build and run'] },
  { id: 'diagnostics', title: 'Diagnostics', sections: ['Background diagnostics'] }
]);

function languageCode() {
  return 'en';
}

function sectionsWithPages(sections) {
  return sections.map(section => ({
    ...section,
    pageId: PAGE_GROUPS.find(page => page.sections.includes(section.title))?.id
  }));
}

function localizeSections(sections) {
  return sectionsWithPages(sections);
}

function localizedPages() {
  return PAGE_GROUPS.map(page => ({ ...page, en: page.title }));
}

module.exports = { PAGE_GROUPS, languageCode, localizeSections, localizedPages, sectionsWithPages };
