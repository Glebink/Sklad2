#!/bin/sh
# Метка версии файлов в index.html (?v=…): браузер (Safari по QR-ссылке) не возьмёт старый auth.js или код модуля из кэша.
# Запускать перед каждым коммитом, меняющим css/js.
V=$(date -u +%y%m%d%H%M)
sed -i -E "s#\?v=[0-9]+\"#?v=$V\"#g" uchet/index.html zayavki/index.html
