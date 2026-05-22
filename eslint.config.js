import mourner from 'eslint-config-mourner';

export default [
    ...mourner,
    {
        files: ['**/*.js', 'bin/flamebearer', 'bin/flamebearer-node']
    }
];
