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
                    let dateLineIndex = -1;
                    
                    while (searchLine < Math.min(i + 3, lines.length)) {
                        const datePattern = /<span class="hidden-date" data-date="(\d{4}-\d{2}-\d{2})">📅<\/span>/;
                        dateMatch = lines[searchLine].match(datePattern);
                        if (dateMatch) {
                            dateLineIndex = searchLine;
                            break;
                        }
                        searchLine++;
                    }

                    if (dateMatch && dateMatch[1] === targetDate) {
                        let taskText = line.replace(/<span class="hidden-date" data-date="\d{4}-\d{2}-\d{2}">📅<\/span>/g, '').trim();
                        
                        tasks.push({
                            text: taskText,
                            sourceFile: file,
                            lineNumber: i
                        });
                    }
                }
            }
        }

        if (tasks.length > 0) {
            await this.insertTasksIntoDaily(dailyFile, tasks);
            await this.removeTasksFromSource(tasks);
            new Notice(`Перенесено ${tasks.length} задач(и)`);
        }
    }

    async insertTasksIntoDaily(file, tasks) {
        let content = await this.app.vault.read(file);
        const section = this.settings.targetSection;

        const taskTexts = tasks.map(task => task.text);

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

                const newTasks = taskTexts.filter(task => !existingTasks.has(task));
                if (newTasks.length > 0) {
                    lines.splice(insertIndex, 0, ...newTasks);
                    content = lines.join('\n');
                    await this.app.vault.modify(file, content);
                }
            }
        } else {
            if (!content.endsWith('\n\n')) content += '\n\n';
            content += `${section}\n${taskTexts.join('\n')}\n`;
            await this.app.vault.modify(file, content);
        }
    }

    async removeTasksFromSource(tasks) {
        const tasksByFile = new Map();
        
        for (const task of tasks) {
            if (!tasksByFile.has(task.sourceFile)) {
                tasksByFile.set(task.sourceFile, []);
            }
            tasksByFile.get(task.sourceFile).push(task.lineNumber);
        }

        for (const [file, lineNumbers] of tasksByFile) {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            
            lineNumbers.sort((a, b) => b - a);
            
            for (const lineNum of lineNumbers) {
                lines.splice(lineNum, 1);
                
                if (lineNum < lines.length && 
                    lines[lineNum].trim().match(/<span class="hidden-date"/)) {
                    lines.splice(lineNum, 1);
                }
            }
            
            await this.app.vault.modify(file, lines.join('\n'));
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// Класс для автодополнения дат с календарём
class DateSuggest extends EditorSuggest {
    constructor(app) {
        super(app);
    }

    onTrigger(cursor, editor, file) {
        const line = editor.getLine(cursor.line);
        const textBeforeCursor = line.substring(0, cursor.ch);
        
        if (textBeforeCursor.endsWith('::date_to ')) {
            return {
                start: { line: cursor.line, ch: cursor.ch - 10 },
                end: cursor,
                query: 'calendar'
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
        
        if (query === 'calendar') {
            return this.getCalendarDates();
        }
        
        if (query === '' || 'date_to'.startsWith(query)) {
            return [{
                label: 'date_to ',
                date: '',
                description: '📅 Выбрать дату из календаря'
            }];
        }

        return [];
    }

    getCalendarDates() {
        const today = new Date();
        const suggestions = [];

        // Сегодня
        suggestions.push({
            label: this.formatDate(today),
            date: this.formatDate(today),
            description: '📅 Сегодня'
        });

        // Завтра
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        suggestions.push({
            label: this.formatDate(tomorrow),
            date: this.formatDate(tomorrow),
            description: '📅 Завтра'
        });

        // Послезавтра
        const dayAfterTomorrow = new Date(today);
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
        suggestions.push({
            label: this.formatDate(dayAfterTomorrow),
            date: this.formatDate(dayAfterTomorrow),
            description: '📅 Послезавтра'
        });

        // Следующие 7 дней
        for (let i = 3; i <= 9; i++) {
            const futureDate = new Date(today);
            futureDate.setDate(futureDate.getDate() + i);
            const dayName = this.getDayName(futureDate);
            suggestions.push({
                label: this.formatDate(futureDate),
                date: this.formatDate(futureDate),
                description: `📅 ${dayName}, ${futureDate.getDate()} ${this.getMonthName(futureDate)}`
            });
        }

        // Следующая неделя (понедельник)
        const nextMonday = new Date(today);
        const daysUntilMonday = (8 - today.getDay()) % 7 || 7;
        nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
        suggestions.push({
            label: this.formatDate(nextMonday),
            date: this.formatDate(nextMonday),
            description: `📅 След. понедельник, ${nextMonday.getDate()} ${this.getMonthName(nextMonday)}`
        });

        // Следующие выходные (суббота)
        const nextSaturday = new Date(today);
        const daysUntilSaturday = (6 - today.getDay() + 7) % 7 || 7;
        nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
        suggestions.push({
            label: this.formatDate(nextSaturday),
            date: this.formatDate(nextSaturday),
            description: `📅 Суббота, ${nextSaturday.getDate()} ${this.getMonthName(nextSaturday)}`
        });

        return suggestions;
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    getDayName(date) {
        const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
        return days[date.getDay()];
    }

    getMonthName(date) {
        const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
        return months[date.getMonth()];
    }

    renderSuggestion(suggestion, el) {
        const container = el.createDiv({ cls: 'date-suggest-item' });
        
        const title = container.createDiv({ cls: 'date-suggest-title' });
        title.setText(suggestion.description || suggestion.label);
        
        if (suggestion.date) {
            const dateInfo = container.createDiv({ cls: 'date-suggest-date' });
            dateInfo.setText(suggestion.date);
        }
    }

    selectSuggestion(suggestion, evt) {
        if (!this.context) return;

        const editor = this.context.editor;
        const start = this.context.start;
        const end = this.context.end;

        const dateSpan = `<span class="hidden-date" data-date="${suggestion.date}">📅</span>`;
        
        editor.replaceRange(dateSpan, start, end);

        const newCursor = {
            line: start.line,
            ch: start.ch + dateSpan.length
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

        containerEl.createEl('h3', {text: 'Инструкция'});
        const instructions = containerEl.createEl('div', {cls: 'task-scheduler-instructions'});
        instructions.innerHTML = `
            <p><strong>Автодополнение дат:</strong></p>
            <p>Введите <code>::date_to </code> (с пробелом) — появится календарь с датами.</p>
            <p>Выберите дату → она вставится как 📅</p>
            <p><strong>Важно:</strong> При переносе в daily note задача удаляется из исходного файла.</p>
        `;
    }
}

module.exports = TaskSchedulerPlugin;