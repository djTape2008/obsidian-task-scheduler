const { Plugin, PluginSettingTab, Setting, Notice, Modal, EditorSuggest } = require('obsidian');

const DEFAULT_SETTINGS = {
    sourceFolder: '',
    targetSection: '## Задачи',
    carryOverSection: '## Задачи',
    enableCarryOver: true
};

class TaskSchedulerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new TaskSchedulerSettingTab(this.app, this));

        // Регистрируем подсказку для ::date_to
        this.registerEditorSuggest(new DateTriggerSuggest(this.app, this));
        
        // Регистрируем подсказку для ::repeat
        this.registerEditorSuggest(new RepeatTriggerSuggest(this.app, this));

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
                    setTimeout(async () => {
                        if (this.settings.enableCarryOver) {
                            await this.carryOverUnfinishedTasks(file);
                        }
                        await this.addRecurringTasks(file);
                        await this.processTasks(file);
                    }, 100);
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

        this.addCommand({
            id: 'insert-date-calendar',
            name: 'Вставить дату (календарь)',
            editorCallback: (editor) => {
                new CalendarModal(this.app, (date) => {
                    const cursor = editor.getCursor();
                    const dateSpan = `<span class="hidden-date" data-date="${date}">📅</span>`;
                    editor.replaceRange(dateSpan, cursor);
                }).open();
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

    getPreviousDailyNote(currentFile) {
        const dailyNotesFolder = this.app.internalPlugins?.plugins?.['daily-notes']?.instance?.options?.folder || '';
        const folderPath = dailyNotesFolder ? dailyNotesFolder + '/' : '';
        
        const allDailyNotes = this.app.vault.getMarkdownFiles().filter(file => {
            const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
            return file.path.startsWith(folderPath) && datePattern.test(file.name);
        });

        if (allDailyNotes.length === 0) return null;

        allDailyNotes.sort((a, b) => b.basename.localeCompare(a.basename));

        const currentDate = currentFile.basename;
        for (const note of allDailyNotes) {
            if (note.basename < currentDate) {
                return note;
            }
        }

        return null;
    }

    async carryOverUnfinishedTasks(todayFile) {
        const previousFile = this.getPreviousDailyNote(todayFile);

        if (!previousFile) {
            return;
        }

        const previousContent = await this.app.vault.read(previousFile);
        
        const unfinishedRegex = /\s*[-*+] \[[^xX-]\].*/g;
        const matches = previousContent.match(unfinishedRegex);

        if (!matches || matches.length === 0) {
            return;
        }

        const unfinishedTasks = matches.map(task => task.trim());

        let todayContent = await this.app.vault.read(todayFile);
        const section = this.settings.carryOverSection;

        if (section && todayContent.includes(section)) {
            const lines = todayContent.split('\n');
            const sectionIndex = lines.findIndex(line => line.trim() === section);
            
            if (sectionIndex !== -1) {
                let insertIndex = sectionIndex + 1;
                
                while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
                    insertIndex++;
                }

                lines.splice(insertIndex, 0, ...unfinishedTasks);
                todayContent = lines.join('\n');
                await this.app.vault.modify(todayFile, todayContent);
            }
        } else {
            if (!todayContent.endsWith('\n\n')) {
                todayContent += '\n\n';
            }
            if (section) {
                todayContent += `${section}\n`;
            }
            todayContent += unfinishedTasks.join('\n') + '\n';
            await this.app.vault.modify(todayFile, todayContent);
        }

        new Notice(`Перенесено ${unfinishedTasks.length} незавершённых задач из ${previousFile.basename}`);
    }

    async addRecurringTasks(todayFile) {
        const files = this.app.vault.getMarkdownFiles().filter(file => 
            this.settings.sourceFolder ? file.path.startsWith(this.settings.sourceFolder + '/') : true
        );

        const todayDate = new Date(this.getDateFromFileName(todayFile));
        const dayOfWeek = todayDate.getDay();
        const dayOfMonth = todayDate.getDate();
        const tasksToAdd = [];

        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) continue;

                if (trimmedLine.match(/^[-*+] \[ \]/)) {
                    const repeatMatch = trimmedLine.match(/<span class="repeat-pattern" data-pattern="([^"]+)">🔁<\/span>/);
                    
                    if (repeatMatch) {
                        const pattern = repeatMatch[1].toLowerCase();
                        let shouldAdd = false;

                        switch (pattern) {
                            case 'daily':
                            case 'ежедневно':
                                shouldAdd = true;
                                break;
                            case 'workdays':
                            case 'будни':
                                shouldAdd = dayOfWeek >= 1 && dayOfWeek <= 5;
                                break;
                            case 'weekends':
                            case 'выходные':
                                shouldAdd = dayOfWeek === 0 || dayOfWeek === 6;
                                break;
                            case 'weekly':
                            case 'еженедельно':
                                shouldAdd = dayOfWeek === 1;
                                break;
                            case 'monday':
                            case 'пн':
                                shouldAdd = dayOfWeek === 1;
                                break;
                            case 'tuesday':
                            case 'вт':
                                shouldAdd = dayOfWeek === 2;
                                break;
                            case 'wednesday':
                            case 'ср':
                                shouldAdd = dayOfWeek === 3;
                                break;
                            case 'thursday':
                            case 'чт':
                                shouldAdd = dayOfWeek === 4;
                                break;
                            case 'friday':
                            case 'пт':
                                shouldAdd = dayOfWeek === 5;
                                break;
                            case 'saturday':
                            case 'сб':
                                shouldAdd = dayOfWeek === 6;
                                break;
                            case 'sunday':
                            case 'вс':
                                shouldAdd = dayOfWeek === 0;
                                break;
                            case 'monthly':
                            case 'ежемесячно':
                                shouldAdd = dayOfMonth === 1;
                                break;
                            default:
                                const intervalMatch = pattern.match(/^every-(\d+)-days$/);
                                if (intervalMatch) {
                                    const interval = parseInt(intervalMatch[1]);
                                    const startOfYear = new Date(todayDate.getFullYear(), 0, 1);
                                    const daysSinceStart = Math.floor((todayDate.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
                                    shouldAdd = daysSinceStart % interval === 0;
                                }
                                break;
                        }

                        if (shouldAdd) {
                            const cleanTask = trimmedLine.replace(/<span class="repeat-pattern" data-pattern="[^"]+">🔁<\/span>\s*/g, '').trim();
                            tasksToAdd.push(cleanTask);
                        }
                    }
                }
            }
        }

        if (tasksToAdd.length > 0) {
            let todayContent = await this.app.vault.read(todayFile);
            const section = this.settings.targetSection;

            if (section && todayContent.includes(section)) {
                const lines = todayContent.split('\n');
                const sectionIndex = lines.findIndex(line => line.trim() === section);
                
                if (sectionIndex !== -1) {
                    let insertIndex = sectionIndex + 1;
                    while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
                        insertIndex++;
                    }
                    lines.splice(insertIndex, 0, ...tasksToAdd);
                    todayContent = lines.join('\n');
                    await this.app.vault.modify(todayFile, todayContent);
                }
            } else {
                if (!todayContent.endsWith('\n\n')) todayContent += '\n\n';
                if (section) todayContent += `${section}\n`;
                todayContent += tasksToAdd.join('\n') + '\n';
                await this.app.vault.modify(todayFile, todayContent);
            }

            new Notice(`Добавлено ${tasksToAdd.length} повторяющихся задач(и)`);
        }
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
                        const datePattern = /<span class="hidden-date" data-date="(\d{4}-\d{2}-\d{2})">📅<\/span>/;
                        dateMatch = lines[searchLine].match(datePattern);
                        if (dateMatch) break;
                        searchLine++;
                    }

                    if (dateMatch && dateMatch[1] === targetDate) {
                        // Удаляем все упоминания даты из строки
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
        
        // Берём только чистый текст задач - БЕЗ эмодзи и дат
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

// Подсказка для ::date_to
class DateTriggerSuggest extends EditorSuggest {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onTrigger(cursor, editor, file) {
        const line = editor.getLine(cursor.line);
        const textBeforeCursor = line.substring(0, cursor.ch);
        
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
            return ['date_to'];
        }

        return [];
    }

    renderSuggestion(value, el) {
        const container = el.createDiv({ cls: 'date-trigger-suggest' });
        
        const icon = container.createSpan({ cls: 'date-trigger-icon' });
        icon.setText('📅');
        
        const text = container.createSpan({ cls: 'date-trigger-text' });
        text.setText('date_to');
        
        const hint = container.createDiv({ cls: 'date-trigger-hint' });
        hint.setText('Открыть календарь для выбора даты');
    }

    selectSuggestion(value, evt) {
        if (!this.context) return;

        const editor = this.context.editor;
        const start = this.context.start;
        const end = this.context.end;

        editor.replaceRange('::date_to ', start, end);

        setTimeout(() => {
            new CalendarModal(this.app, (date) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const textBefore = line.substring(0, cursor.ch);
                
                if (textBefore.endsWith('::date_to ')) {
                    const from = { line: cursor.line, ch: cursor.ch - 10 };
                    const to = cursor;
                    editor.replaceRange('', from, to);
                }
                
                const dateSpan = `<span class="hidden-date" data-date="${date}">📅</span>`;
                editor.replaceRange(dateSpan, editor.getCursor());
            }).open();
        }, 100);
    }
}

// Подсказка для ::repeat
class RepeatTriggerSuggest extends EditorSuggest {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onTrigger(cursor, editor, file) {
        const line = editor.getLine(cursor.line);
        const textBeforeCursor = line.substring(0, cursor.ch);
        
        const match = textBeforeCursor.match(/::(repeat)?$/);
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
        
        if (query === '' || 'repeat'.startsWith(query)) {
            return [
                { label: 'daily', pattern: 'daily', description: '🔁 Каждый день' },
                { label: 'workdays', pattern: 'workdays', description: '🔁 По будням (пн-пт)' },
                { label: 'weekends', pattern: 'weekends', description: '🔁 По выходным (сб-вс)' },
                { label: 'weekly', pattern: 'weekly', description: '🔁 Каждую неделю (пн)' },
                { label: 'monday', pattern: 'monday', description: '🔁 Каждый понедельник' },
                { label: 'tuesday', pattern: 'tuesday', description: '🔁 Каждый вторник' },
                { label: 'wednesday', pattern: 'wednesday', description: '🔁 Каждую среду' },
                { label: 'thursday', pattern: 'thursday', description: '🔁 Каждый четверг' },
                { label: 'friday', pattern: 'friday', description: '🔁 Каждую пятницу' },
                { label: 'saturday', pattern: 'saturday', description: '🔁 Каждую субботу' },
                { label: 'sunday', pattern: 'sunday', description: '🔁 Каждое воскресенье' },
                { label: 'monthly', pattern: 'monthly', description: '🔁 Каждый месяц (1 числа)' },
                { label: 'every 3 days', pattern: 'every-3-days', description: '🔁 Каждые 3 дня' },
                { label: 'every 7 days', pattern: 'every-7-days', description: '🔁 Каждые 7 дней' },
                { label: 'every 14 days', pattern: 'every-14-days', description: '🔁 Каждые 14 дней' },
            ];
        }

        return [];
    }

    renderSuggestion(value, el) {
        const container = el.createDiv({ cls: 'repeat-trigger-suggest' });
        
        const title = container.createDiv({ cls: 'repeat-trigger-title' });
        title.setText(value.description);
        
        const hint = container.createDiv({ cls: 'repeat-trigger-hint' });
        hint.setText(`Шаблон: ${value.label}`);
    }

    selectSuggestion(value, evt) {
        if (!this.context) return;

        const editor = this.context.editor;
        const start = this.context.start;
        const end = this.context.end;

        const repeatSpan = `<span class="repeat-pattern" data-pattern="${value.pattern}">🔁</span>`;
        editor.replaceRange(repeatSpan, start, end);

        const newCursor = {
            line: start.line,
            ch: start.ch + repeatSpan.length
        };
        editor.setCursor(newCursor);
    }
}

// Модальное окно с календарём
class CalendarModal extends Modal {
    constructor(app, onSubmit) {
        super(app);
        this.onSubmit = onSubmit;
        this.currentMonth = new Date();
        this.currentMonth.setDate(1);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('calendar-modal');
        this.renderCalendar();
    }

    renderCalendar() {
        const { contentEl } = this;
        contentEl.empty();

        const header = contentEl.createDiv({ cls: 'calendar-header' });
        
        const prevBtn = header.createEl('button', { text: '‹', cls: 'calendar-nav-btn' });
        prevBtn.onclick = () => {
            this.currentMonth.setMonth(this.currentMonth.getMonth() - 1);
            this.renderCalendar();
        };

        const monthYear = header.createDiv({ cls: 'calendar-month-year' });
        monthYear.setText(this.getMonthYearText());

        const nextBtn = header.createEl('button', { text: '›', cls: 'calendar-nav-btn' });
        nextBtn.onclick = () => {
            this.currentMonth.setMonth(this.currentMonth.getMonth() + 1);
            this.renderCalendar();
        };

        const weekdays = contentEl.createDiv({ cls: 'calendar-weekdays' });
        const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        dayNames.forEach(day => {
            weekdays.createDiv({ text: day, cls: 'calendar-weekday' });
        });

        const daysGrid = contentEl.createDiv({ cls: 'calendar-days' });
        
        const firstDay = new Date(this.currentMonth);
        const lastDay = new Date(this.currentMonth.getFullYear(), this.currentMonth.getMonth() + 1, 0);
        
        let startDay = firstDay.getDay() - 1;
        if (startDay === -1) startDay = 6;

        for (let i = 0; i < startDay; i++) {
            daysGrid.createDiv({ cls: 'calendar-day calendar-day-empty' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (let day = 1; day <= lastDay.getDate(); day++) {
            const date = new Date(this.currentMonth.getFullYear(), this.currentMonth.getMonth(), day);
            const dayEl = daysGrid.createDiv({ 
                text: day.toString(), 
                cls: 'calendar-day' 
            });

            if (date.getTime() === today.getTime()) {
                dayEl.addClass('calendar-day-today');
            }

            if (date < today) {
                dayEl.addClass('calendar-day-past');
            } else {
                dayEl.onclick = () => {
                    const dateStr = this.formatDate(date);
                    this.onSubmit(dateStr);
                    this.close();
                };
            }
        }

        const footer = contentEl.createDiv({ cls: 'calendar-footer' });
        const todayBtn = footer.createEl('button', { text: 'Сегодня', cls: 'calendar-today-btn' });
        todayBtn.onclick = () => {
            const dateStr = this.formatDate(new Date());
            this.onSubmit(dateStr);
            this.close();
        };
    }

    getMonthYearText() {
        const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 
                       'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        return `${months[this.currentMonth.getMonth()]} ${this.currentMonth.getFullYear()}`;
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
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

        containerEl.createEl('h3', {text: 'Перенос невыполненных задач'});

        new Setting(containerEl)
            .setName('Включить перенос задач')
            .setDesc('Автоматически переносить невыполненные задачи из вчерашней заметки')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCarryOver)
                .onChange(async (value) => {
                    this.plugin.settings.enableCarryOver = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Раздел для переноса')
            .setDesc('В какой раздел вставлять перенесённые задачи (оставьте пустым для вставки в конец)')
            .addText(text => text
                .setPlaceholder('## Задачи')
                .setValue(this.plugin.settings.carryOverSection)
                .onChange(async (value) => {
                    this.plugin.settings.carryOverSection = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', {text: 'Перенос невыполненных задач'});
        const instructions = containerEl.createEl('div', {cls: 'task-scheduler-instructions'});
        instructions.innerHTML = `
            <p><strong>Календарь дат:</strong></p>
            <p>Введите <code>::date_to</code> — появится подсказка. Нажмите Enter — откроется календарь.</p>
            
            <p><strong>Повторяющиеся задачи:</strong></p>
            <p>Создайте файл со списком повторяющихся задач. Добавьте 🔁 с типом:</p>
            <p><code>- [ ] Зарядка 🔁daily</code> (каждый день)<br>
            <code>- [ ] Планирование 🔁weekly</code> (каждый понедельник)<br>
            <code>- [ ] Отчёт 🔁workdays</code> (будни)<br>
            <code>- [ ] Встреча 🔁monday</code> (по понедельникам)<br>
            <code>- [ ] Бассейн 🔁3</code> (каждые 3 дня)</p>
            
            <p><strong>Перенос незавершённых:</strong> Все <code>- [ ]</code> задачи из предыдущей daily note автоматически переносятся.</p>
        `;
    }
}

module.exports = TaskSchedulerPlugin;