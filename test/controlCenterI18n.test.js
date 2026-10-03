'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGE_GROUPS, languageCode, localizedPages, sectionsWithPages } = require('../src/controlCenterI18n');

test('control center defaults to Chinese and exposes seven consolidated pages', () => {
  assert.equal(languageCode(undefined), 'zh-CN');
  assert.deepEqual(localizedPages('zh-CN').map(page => page.title), [
    '通用', '编辑体验', '导航与符号', '格式化', '工程与文件', '构建与调试', '诊断'
  ]);
  assert.equal(PAGE_GROUPS.length, 7);
});

test('English control-center localization translates sections, settings, options and units', () => {
  const source = [{
    title: '界面与语言',
    description: '控制 Pascal Union 设置页面使用的界面语言。',
    settings: [{
      key: 'ui.language', label: '配置语言', type: 'select', unit: '行',
      options: ['zh-CN', 'en'], optionLabels: ['简体中文（默认）', '英文']
    }],
    actions: []
  }];
  const [section] = sectionsWithPages(source, 'en');
  assert.equal(section.pageId, 'general');
  assert.equal(section.title, 'Interface language');
  assert.equal(section.settings[0].label, 'Settings language');
  assert.deepEqual(section.settings[0].optionLabels, ['Simplified Chinese (default)', 'English']);
  assert.equal(section.settings[0].unit, 'lines');
});
