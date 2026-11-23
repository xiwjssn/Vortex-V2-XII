'use strict';

const ICONS = {
  help: '📚', info: '🪪', ping: '⚡', uid: '🆔', uptime: '⏳',
  admin: '🛡️', groups: '🗂️', kick: '🚪', reload: '♻️', song: '🎵',
  avatar: '🖼️', nm: '🏷️', vortex: '🌀', حذف: '🗑️'
};

module.exports = {
  name: 'help',
  aliases: ['مساعدة', 'اوامر'],
  description: 'دليل VORTEX للأوامر',
  async execute(api, event) {
    const commands = event.runtime.getCommands();
    const list = commands.map(command => {
      const icon = ICONS[command.name] || '✦';
      return icon + '  ' + event.config.prefix + command.name + '\n' +
        '   ↳ ' + command.description;
    }).join('\\n\\n');

    const message = [
      '╭─「 📚 دليل الأوامر 」',
      '│ ✨ أوامر VORTEX مرتبة لك',
      '│ 💡 اكتب الأمر مع البادئة ' + event.config.prefix,
      '├────────────────',
      list || '📭 لا توجد أوامر متاحة حاليًا.',
      '╰─「 ⟡ VORTEX 」'
    ].join('\\n');

    return api.sendMessage(message, event.threadID, event.messageID);
  }
};
