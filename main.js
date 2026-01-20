const { Plugin, PluginSettingTab, Setting, Notice, EditorSuggest } = require('obsidian');

const DEFAULT_SETTINGS = {
    sourceFolder: '',
    targetSection: '## Задачи'
};

class TaskSchedulerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new TaskSchedulerSettingTab(this.app, this));

        // Регистрируем автодополнение
        this.registerEditorSuggest(new DateSuggest(this.app));

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && this.isDailyNote(file)) {
                    this.processTasks(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file && this.isDailyNote(file)) {
                    setTimeout(() => this.processTasks(file), 100);
                }
            })
        );

        this.addCommand({
            id: 'update-daily-tasks',
            name: 'Обновить задачи в текущей заметке',
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && this.isDailyNote(activeFile)) {
                    this.processTasks(activeFile);
                } else {
                    new Notice('Это не ежедневная заметка');
                }
            }
        });
    }

    isDailyNote(file) {
        const dailyNotesFolder = this.app.internalPlugins?.plugins?.['daily-notes']?.instance?.options?.folder || '';
        const folderPath = dailyNotesFolder ? dailyNotesFolder + '/' : '';
        const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
        return file.path.startsWith(folderPath) && datePattern.test(file.name);
    }

    getDateFromFileName(file) {
        return file.basename;
    }

    async processTasks(dailyFile) {
        if (!this.settings.sourceFolder) return;

        const targetDate = this.getDateFromFileName(dailyFile);
        const tasks = [];

        const files = this.app.vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(this.settings.sourceFolder + '/')
        );

        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                if (line.trim().startsWith('- [ ]')) {
                    let dateMatch = null;
                    let searchLine = i;
                    
                    while (searchLine < Math.min(i + 3, lines.length)) {
                        const datePattern = /::date_to\s+(\d{4}-\d{2}-\d{2})/;
                        dateMatch = lines[searchLine].match(datePattern);
                        if (dateMatch) break;
                        searchLine++;
                    }

                    if (dateMatch && dateMatch[1] === targetDate) {
                        const taskText = line.replace(/::date_to\s+\d{4}-\d{2}-\d{2}/, '').trim();
                        tasks.push(`${taskText} [[${file.basename}]]`);
                    }
                }
            }
        }

        if (tasks.length > 0) {
            await this.insertTasksIntoDaily(dailyFile, tasks);
            new Notice(`Добавлено ${tasks.length} задач(и)`);
        }
    }

    async insertTasksIntoDaily(file, tasks) {
        let content = await this.app.vault.read(file);
        const section = this.settings.targetSection;

        if (content.includes(section)) {
            const lines = content.split('\n');
            const sectionIndex = lines.findIndex(line => line.trim() === section);
            
            if (sectionIndex !== -1) {
                let insertIndex = sectionIndex + 1;
                while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
                    insertIndex++;
                }

                const existingTasks = new Set();
                for (let i = insertIndex; i < lines.length; i++) {
                    if (lines[i].startsWith('#')) break;
                    if (lines[i].trim().startsWith('- [ ]')) {
                        existingTasks.add(lines[i].trim());
                    }
                }

                const newTasks = tasks.filter(task => !existingTasks.has(task));
                if (newTasks.length > 0) {
                    lines.splice(insertIndex, 0, ...newTasks);
                    content = lines.join('\n');
                    await this.app.vault.modify(file, content);
                }
            }
        } else {
            if (!content.endsWith('\n\n')) content += '\n\n';
            content += `${section}\n${tasks.join('\n')}\n`;
            await this.app.vault.modify(file, content);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// Класс для автодополнения дат
class DateSuggest extends EditorSuggest {
    constructor(app) {
        super(app);
    }

    onTrigger(cursor, editor, file) {
        const line = editor.getLine(cursor.line);
        const textBeforeCursor = line.substring(0, cursor.ch);
        
        if (textBeforeCursor.endsWith('::')) {
            return {
                start: { line: cursor.line, ch: cursor.ch - 2 },
                end: cursor,
                query: ''
            };
        }

        const match = textBeforeCursor.match(/::(date_to)?$/);
        if (match) {
            return {
                start: { line: cursor.line, ch: cursor.ch - match[0].length },
                end: cursor,
                query: match[1] || ''
            };
        }

        return null;
    }

    getSuggestions(context) {
        const query = context.query.toLowerCase();
        
        if (query === '' || 'date_to'.startsWith(query)) {
            if (query.length < 7) {
                return [{
                    label: 'date_to',
                    date: '',
                    description: 'Добавить дату выполнения'
                }];
            }
            
            return this.getDateOptions();
        }

        return [];
    }

    getDateOptions() {
        const today = new Date();
        const suggestions = [];

        // Завтра
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        suggestions.push({
            label: `date_to ${this.formatDate(tomorrow)}`,
            date: this.formatDate(tomorrow),
            description: '📅 Завтра'
        });

        // Послезавтра
        const dayAfterTomorrow = new Date(today);
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
        suggestions.push({
            label: `date_to ${this.formatDate(dayAfterTomorrow)}`,
            date: this.formatDate(dayAfterTomorrow),
            description: '📅 Послезавтра'
        });

        // Следующие выходные (суббота)
        const nextWeekend = new Date(today);
        const daysUntilSaturday = (6 - today.getDay() + 7) % 7 || 7;
        nextWeekend.setDate(nextWeekend.getDate() + daysUntilSaturday);
        suggestions.push({
            label: `date_to ${this.formatDate(nextWeekend)}`,
            date: this.formatDate(nextWeekend),
            description: '📅 Выходные (суббота)'
        });

        // Через неделю
        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        suggestions.push({
            label: `date_to ${this.formatDate(nextWeek)}`,
            date: this.formatDate(nextWeek),
            description: '📅 Через неделю'
        });

        return suggestions;
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    renderSuggestion(suggestion, el) {
        const container = el.createDiv({ cls: 'date-suggest-item' });
        
        const title = container.createDiv({ cls: 'date-suggest-title' });
        title.setText(suggestion.label);
        
        if (suggestion.description) {
            const desc = container.createDiv({ cls: 'date-suggest-description' });
            desc.setText(suggestion.description);
        }
    }

    selectSuggestion(suggestion, evt) {
        if (!this.context) return;

        const editor = this.context.editor;
        const start = this.context.start;
        const end = this.context.end;

        editor.replaceRange(`::${suggestion.label}`, start, end);

        const newCursor = {
            line: start.line,
            ch: start.ch + suggestion.label.length + 2
        };
        editor.setCursor(newCursor);
    }
}

class TaskSchedulerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const {containerEl} = this;
        containerEl.empty();
        containerEl.createEl('h2', {text: 'Настройки Task Scheduler'});

        new Setting(containerEl)
            .setName('Исходная папка')
            .setDesc('Папка с задачами (например: Tasks)')
            .addText(text => text
                .setPlaceholder('Tasks')
                .setValue(this.plugin.settings.sourceFolder)
                .onChange(async (value) => {
                    this.plugin.settings.sourceFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Заголовок раздела')
            .setDesc('Заголовок в daily note')
            .addText(text => text
                .setPlaceholder('## Задачи')
                .setValue(this.plugin.settings.targetSection)
                .onChange(async (value) => {
                    this.plugin.settings.targetSection = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', {text: 'Автодополнение'});
        const autoInfo = containerEl.createEl('p');
        autoInfo.setText('Введите :: в любом месте, чтобы увидеть варианты дат');
    }
}

module.exports = TaskSchedulerPlugin;