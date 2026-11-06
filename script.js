// Ano automático no rodapé
document.getElementById('ano').textContent = new Date().getFullYear();

// Formulário: abre o app de e-mail já preenchido para caarldev@gmail.com
document.getElementById('form').addEventListener('submit', function (e) {
  e.preventDefault();
  var d = new FormData(this);
  var assunto = 'Projeto de ' + d.get('tipo') + ' - ' + d.get('nome');
  var corpo = 'Nome: ' + d.get('nome') + '\nE-mail: ' + d.get('email') +
              '\nTipo de projeto: ' + d.get('tipo') + '\n\n' + d.get('mensagem');
  window.location.href = 'mailto:caarldev@gmail.com?subject=' +
    encodeURIComponent(assunto) + '&body=' + encodeURIComponent(corpo);
});