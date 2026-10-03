# CashFlux — mes comptes

Application web installable (PWA) de suivi de comptes bancaires : multi-comptes, budgets automatiques, prévisions, import de captures d'écran avec reconnaissance de texte sur l'appareil.

## Mise en ligne avec GitHub Pages
1. Crée un dépôt (il peut être privé avec un compte GitHub payant ; sinon public — aucune donnée personnelle n'est dans le code).
2. Dépose tous les fichiers de ce dossier à la racine du dépôt.
3. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)`.
4. Attends une minute : l'app est disponible sur `https://<ton-pseudo>.github.io/<nom-du-depot>/`.

## Installation sur iPhone
Ouvre l'adresse dans **Safari** → bouton Partager → **Sur l'écran d'accueil**.

## Données
Tout reste sur le téléphone (aucun serveur). Pense à exporter une sauvegarde régulièrement depuis Réglages : supprimer l'app de l'écran d'accueil efface les données.

## Mise à jour
Modifie les fichiers sur GitHub, puis incrémente `CACHE` dans `sw.js` (ex. `cashflux-v2`) pour forcer le rafraîchissement.
