/** MVP category policy; adjust explicitly for a new category and re-run acceptance. */
export const CATEGORY = {
 id: 'machined-metal-parts', name: '机械零部件 / 金属加工件',
 required: ['productName','model','quantity','unit','material','dimensions'],
 allowNotApplicable: ['dimensions','technicalParameters'],
 units: ['pcs','pc','piece','pieces','ea','each','set','sets','kg','g','m','meter','meters','metre','metres','pair','pairs','件','个','套','千克','克','米','对'],
};
export function isUnclear(value:string) {return !value.trim() || /^(?:tbc|tbd|unknown|unclear|n\/?a|pending|待确认|未知|不明确|不详|\?)$/i.test(value.trim());}
