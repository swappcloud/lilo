import type { PluginListItem, PluginUi } from "../types";

export function pluginText(ui: PluginUi, locale: string): (text: string) => string {
  const dictionaries = Object.entries(ui.localized ?? {});
  const tag = locale.toLowerCase();
  const regional = dictionaries.find(([key]) => key.toLowerCase() === tag)?.[1];
  const primary = dictionaries.find(([key]) => key.toLowerCase() === tag.split("-")[0])?.[1];
  return (text) => {
    const dictionary = regional && Object.hasOwn(regional, text) ? regional : primary;
    const translated = dictionary && Object.hasOwn(dictionary, text) ? dictionary[text] : undefined;
    return typeof translated === "string" ? translated : text;
  };
}

/** Translate display fields only; keys, tool names, arguments and defaults stay intact. */
export function localizedPluginUi(ui: PluginUi, locale: string): PluginUi {
  const text = pluginText(ui, locale);
  return {
    ...ui,
    settings: ui.settings.map((field) => ({ ...field, label: text(field.label),
      help: field.help ? text(field.help) : field.help,
      placeholder: field.placeholder ? text(field.placeholder) : field.placeholder,
      options: field.options?.map((option) => ({ ...option, label: text(option.label) })),
    })),
    status: ui.status.map((row) => ({ ...row, label: text(row.label), value: text(row.value) })),
    actions: ui.actions.map((action) => ({ ...action, label: text(action.label) })),
    list: ui.list ? { ...ui.list, title: text(ui.list.title), empty: ui.list.empty ? text(ui.list.empty) : ui.list.empty } : ui.list,
    lists: ui.lists?.map((list) => ({ ...list, title: text(list.title), empty: list.empty ? text(list.empty) : list.empty })),
    cards: ui.cards?.map((card) => ({...card,title:text(card.title)})),
    progress: ui.progress?.map((progress) => ({...progress,title:text(progress.title)})),
    forms: ui.forms?.map((form) => ({...form,title:text(form.title),submitLabel:text(form.submitLabel),fields:form.fields.map((field)=>({...field,label:text(field.label),options:field.options?.map((option)=>({...option,label:text(option.label)}))}))})),
  };
}

export function localizedPluginItem(ui: PluginUi, locale: string, item: PluginListItem): PluginListItem {
  const text = pluginText(ui, locale);
  return { ...item, label: text(item.label), detail: item.detail ? text(item.detail) : item.detail,
    action: item.action ? { ...item.action, label: text(item.action.label) } : item.action,
    edit: item.edit ? { ...item.edit, label: text(item.edit.label) } : item.edit,
    deleteAction: item.deleteAction ? { ...item.deleteAction, label: text(item.deleteAction.label) } : item.deleteAction };
}
